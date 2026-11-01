// bedrock-protocol's Relay, with the upstream connection tied to the LAN player's lifetime.
//
// The stock Relay starts a player's upstream connection when they join and only links
// it to the player once the remote accepts them. If the player leaves first (e.g. they
// were kicked to do the one-time Microsoft sign-in), the upstream connection carries on
// and joins the remote server as them with nobody attached. Their next attempt is then a
// second login for an account that's already online, which the server rejects.
//
// This version cancels the upstream connection when the player leaves, passes the
// remote server's own disconnect reason through to the player instead of a generic one,
// forwards packets as their original bytes (including split-screen players'), and keeps
// batches within NetherNet's message size limit.

import { Relay, Client } from 'bedrock-protocol'
import createDebug from 'debug'
import minecraftData from 'minecraft-data'
import { Connection as BedrockConnection } from 'bedrock-protocol/src/connection.js'
import { Framer } from 'bedrock-protocol/src/transforms/framer.js'
import { Connection as NethernetConnection } from 'nethernet/src/connection.js'
import type {
  ConnectionInternals, DisconnectParams, MsaCode, ParsedPacket, RelayInternals,
  RelayPlayerInternals, UpstreamClient, UpstreamNethernetOptions
} from './types/internals.ts'

const debug = createDebug('minecraft-protocol')

// ---------------------------------------------------------------------------------------
// Packet headers

interface PacketHeader {
  /** Packet ID (bits 0-9 of the header varint). */
  id: number
  /** Split-screen player number, or 0 for the main player. */
  sub: number
  /** Length of the header varint in bytes. */
  length: number
}

// Packet header: a varint holding the packet ID (bits 0-9) and, for split-screen players,
// which "sub-client" it's from or for (bits 10-13). Sub-clients share the first player's
// connection. bedrock-protocol doesn't understand those bits, so it mangles such packets.
export function readHeader (packet: Buffer): PacketHeader {
  let value = 0
  let shift = 0
  let length = 0
  for (let i = 0; i < packet.length && i < 5; i++) {
    const byte = packet[i]!
    value |= (byte & 0x7f) << shift
    length = i + 1
    if (!(byte & 0x80)) break
    shift += 7
  }
  // Two 2-bit fields: sender sub-client (bits 10-11) and target sub-client (bits 12-13).
  // Either being set means the packet belongs to a split-screen player.
  const sender = (value >> 10) & 0x3
  const target = (value >> 12) & 0x3
  return { id: value & 0x3ff, sub: sender || target, length }
}

export function writeVarint (n: number): Buffer {
  const out: number[] = []
  while (n > 0x7f) { out.push((n & 0x7f) | 0x80); n >>>= 7 }
  out.push(n)
  return Buffer.from(out)
}

interface Inspected extends PacketHeader {
  des?: ParsedPacket
  error?: Error
}

// ---------------------------------------------------------------------------------------
// Raw relaying

// TypeScript mixins require a constructor with a single any[] rest parameter.
type RelayPlayerConstructor = new (...args: any[]) => RelayPlayerInternals

// Every packet is forwarded as the exact bytes received. Decoding and re-encoding them
// (what the stock Relay does) risks small differences the game rejects, and can't handle
// sub-client packets at all. NetherNet has no game-layer encryption, so raw bytes are
// valid on the other side. Packets are still decoded for logging and for the few the
// proxy has to act on.
function withRawRelay<TBase extends RelayPlayerConstructor> (Base: TBase, packetNames: Record<string, string>) {
  const nameOf = (id: number): string => packetNames[id] ?? `packet_${id}`

  return class RawRelayPlayer extends Base {
    // Decode a packet for inspection; for sub-client packets, strip the sub-client bits
    // first so bedrock-protocol can read the body.
    inspect (packet: Buffer): Inspected {
      const header = readHeader(packet)
      try {
        const buf = header.sub ? Buffer.concat([writeVarint(header.id), packet.subarray(header.length)]) : packet
        return { ...header, des: this.server.deserializer.parsePacketBuffer(buf) }
      } catch (err) {
        return { ...header, error: err as Error }
      }
    }

    describe ({ id, sub }: PacketHeader): string {
      return sub ? `${nameOf(id)} (split-screen player ${sub})` : nameOf(id)
    }

    // Console → proxy → remote
    override readPacket (packet: Buffer): void {
      if (!this.startRelaying) return super.readPacket(packet) // our own login handshake
      if (!this.upstream) {
        this.upQ.push(packet)
        return
      }
      this.flushUpQueue()
      this.relayUp(packet)
    }

    relayUp (packet: Buffer): void {
      const upstream = this.upstream
      if (!upstream) {
        this.upQ.push(packet)
        return
      }
      const info = this.inspect(packet)
      const name = info.des?.data.name
      if (info.sub) {
        this.downInLog(`${this.describe(info)}, ${packet.length} bytes`)
        if (name === 'sub_client_login') this.server.emit('subClientLogin', this, info.sub)
      } else if (!info.des) {
        this.downInLog(`${this.describe(info)} (could not decode: ${info.error?.message}), relaying raw`)
      } else {
        this.downInLog('recv', name, info.des.data.params)
        this.emit('serverbound', info.des.data, info.des)
        if (info.des.canceled) return
        if (name === 'client_cache_status') {
          // The relay can't serve cached chunks, so keep the cache off upstream.
          upstream.queue('client_cache_status', { enabled: !!this.server.enableChunkCaching })
          return
        }
        if (name === 'set_local_player_as_initialized') this.status = 3
      }
      upstream.sendBuffer(packet)
    }

    override flushUpQueue (): void {
      const queued = this.upQ
      this.upQ = []
      for (const packet of queued) this.relayUp(packet)
    }

    // Remote → proxy → console
    override readUpstream (packet: Buffer): void {
      if (!this.startRelaying) {
        this.downQ.push(packet)
        return
      }
      const info = this.inspect(packet)
      const name = info.des?.data.name
      const params = info.des?.data.params

      if (info.sub) {
        this.upInLog(`-> ${this.describe(info)}, ${packet.length} bytes`)
        if (name === 'disconnect') this.server.emit('subClientKick', this, info.sub, params as DisconnectParams)
        if (name === 'play_status') this.server.emit('subClientStatus', this, info.sub, params?.status)
        this.sendBuffer(packet)
        return
      }
      if (!info.des || !name || !params) {
        this.upInLog(`-> ${this.describe(info)} (could not decode: ${info.error?.message}), relaying raw`)
        this.sendBuffer(packet)
        return
      }

      this.upInLog('->', name, params)
      // The proxy already sent its own login_success during the LAN handshake.
      if (name === 'play_status' && params.status === 'login_success') return
      this.emit('clientbound', info.des.data, info.des)
      if (info.des.canceled) return
      this._processOutbound(name, params) // keep item palette variables in sync for decoding

      if (name === 'start_game') {
        setTimeout(() => { this.sentStartGame = true }, 500)
      } else if (name === 'level_chunk' && !this.sentStartGame) {
        this.chunkSendCache.push(packet)
        return
      }
      this.sendBuffer(packet, name === 'level_chunk') // chunks go out immediately, as before

      if (this.chunkSendCache.length && this.sentStartGame) {
        for (const chunk of this.chunkSendCache) this.sendBuffer(chunk, true)
        this.chunkSendCache = []
      }
    }

    override flushDownQueue (): void {
      const queued = this.downQ
      this.downQ = []
      for (const packet of queued) this.readUpstream(packet)
    }
  }
}

// ---------------------------------------------------------------------------------------
// NetherNet message size

// NetherNet sends each message as up to 256 segments of 10,000 bytes, with the count in a
// single byte. bedrock-protocol bundles everything queued in a 20 ms tick into one batch,
// and a burst (like a split-screen player's whole world setup, ~3.5 MB) can exceed that,
// silently wrapping the count and corrupting the stream. Cap batches well below the limit.
export const MAX_BATCH_BYTES = 1_000_000
const NETHERNET_MAX_MESSAGE = 256 * 10_000

BedrockConnection.prototype._tick = function (this: ConnectionInternals): void {
  if (!this.sendQ.length) return
  const queued = this.sendQ
  this.sendQ = []
  this.sendIds = []
  let chunk: Buffer[] = []
  let size = 0
  const flush = (): void => {
    if (!chunk.length) return
    const batch = new Framer(this)
    batch.addEncodedPackets(chunk)
    if (this.encryptionEnabled) this.sendEncryptedBatch(batch)
    else this.sendDecryptedBatch(batch)
    chunk = []
    size = 0
  }
  for (const packet of queued) {
    if (size && size + packet.length > MAX_BATCH_BYTES) flush()
    chunk.push(packet)
    size += packet.length
  }
  flush()
}

// And refuse, loudly, to send a message that still wouldn't fit, instead of corrupting it.
const sendNow = NethernetConnection.prototype.sendNow
NethernetConnection.prototype.sendNow = function (this: NethernetConnection, data: Buffer): number {
  if (data.length > NETHERNET_MAX_MESSAGE) throw new Error(`NetherNet message too large (${data.length} bytes)`)
  return sendNow.call(this, data)
}

// ---------------------------------------------------------------------------------------
// The relay

/** Events ProxyRelay emits, beyond bedrock-protocol's 'connect'. */
export interface ProxyRelayEvents {
  connect: [player: RelayPlayerInternals]
  join: [player: RelayPlayerInternals, upstream: UpstreamClient]
  upstreamKick: [player: RelayPlayerInternals, packet: DisconnectParams]
  upstreamCancelled: [player: RelayPlayerInternals, upstream: UpstreamClient]
  subClientLogin: [player: RelayPlayerInternals, sub: number]
  subClientStatus: [player: RelayPlayerInternals, sub: number, status: unknown]
  subClientKick: [player: RelayPlayerInternals, sub: number, packet: DisconnectParams | undefined]
  error: [error: Error]
}

/** What LanProxy passes to the relay (a superset of bedrock-protocol's RelayOptions). */
export interface ProxyRelayOptions {
  transport: 'nethernet'
  version: string
  host?: string
  maxPlayers?: number
  nethernet: { webrtcBackend?: 'werift' | 'wrtc' | 'auto' }
  logging: boolean
  offline: boolean
  profilesFolder?: string
  destination: {
    transport: 'nethernet'
    offline: boolean
    nethernet: UpstreamNethernetOptions
  }
  advertisementFn: () => RelayInternals['advertisement']
  onMsaCode: (code: MsaCode, player: RelayPlayerInternals) => void
}

/** Upstream Client options (bedrock-protocol's ClientOptions plus the fields it reads internally). */
interface UpstreamClientOptions {
  authTitle?: string
  flow?: string
  deviceType?: string
  offline?: boolean
  username?: string
  version: string
  host?: string
  port?: number
  transport?: 'raknet' | 'nethernet'
  nethernet?: UpstreamNethernetOptions
  batchingInterval?: number
  onMsaCode: (code: MsaCode) => void
  profilesFolder?: string | false
  autoInitPlayer: boolean
}

export class ProxyRelay extends Relay {
  constructor (options: ProxyRelayOptions) {
    super(options as unknown as ConstructorParameters<typeof Relay>[0])
    const self = this as unknown as RelayInternals
    const protocol = minecraftData('bedrock_' + self.options.version).protocol as {
      types: { mcpe_packet: [string, [{ type: [string, { mappings: Record<string, string> }] }]] }
    }
    const names = protocol.types.mcpe_packet[1][0].type[1].mappings
    self.RelayPlayer = withRawRelay(self.RelayPlayer, names)
  }

  async openUpstreamConnection (ds: RelayPlayerInternals, clientAddr: bigint): Promise<void> {
    const self = this as unknown as RelayInternals
    const key = String(clientAddr)
    const o = self.options
    const options: UpstreamClientOptions = {
      authTitle: o.authTitle,
      flow: o.flow,
      deviceType: o.deviceType,
      offline: o.destination.offline ?? o.offline,
      username: o.offline ? ds.profile?.name : ds.profile?.xuid,
      version: o.version,
      host: o.destination.host,
      port: o.destination.port,
      transport: o.destination.transport,
      nethernet: o.destination.nethernet,
      batchingInterval: o.batchingInterval,
      onMsaCode: (code) => {
        if (o.onMsaCode) o.onMsaCode(code, ds)
        else ds.disconnect('Sign in at ' + code.verification_uri + ' with code ' + code.user_code)
      },
      profilesFolder: o.profilesFolder,
      autoInitPlayer: false
    }

    // If the player is already gone (left during the join handshake), don't start.
    if (ds._closed) return

    const client = new Client(options as unknown as ConstructorParameters<typeof Client>[0]) as unknown as UpstreamClient
    if (!client.noLoginForward) client.options.skinData = ds.skinData
    client.outLog = ds.upOutLog
    client.inLog = ds.upInLog

    let kick: DisconnectParams | null = null
    let finished = false
    const finish = (): void => {
      finished = true
      ds.off('close', onPlayerClose)
      if (self.upstreams.get(key) === client) self.upstreams.delete(key)
    }

    // Player left before (or after) the remote accepted them: cancel the upstream.
    // Microsoft sign-in still completes and caches its token if it's in progress.
    const onPlayerClose = (): void => {
      if (finished) return
      finish()
      this.emit('upstreamCancelled', ds, client)
      client.close()
    }
    ds.once('close', onPlayerClose)

    client.on('kick', (packet: DisconnectParams) => {
      kick = packet
      this.emit('upstreamKick', ds, packet)
    })

    client.once('join', () => {
      if (finished) return client.close()
      client.write('client_cache_status', { enabled: self.enableChunkCaching })
      ds.upstream = client
      ds.flushUpQueue()
      self.conLog('Connected to upstream server')
      client.readPacket = (packet: Buffer) => ds.readUpstream(packet)
      this.emit('join', ds, client)
    })

    client.on('error', (err: Error) => {
      if (finished) return
      finish()
      debug(clientAddr, 'was disconnected because of error', err)
      ds.disconnect('Could not reach the server: ' + err.message)
    })

    client.on('close', () => {
      if (finished) return
      finish()
      // Pass the server's own message through; the game translates keys like
      // disconnectionScreen.loggedinOtherLocation into readable text.
      ds.disconnect(kick?.message || 'The server closed the connection')
    })

    self.upstreams.set(key, client)
    client.connect()
  }

  /** Typed view of this relay's events. */
  get events (): import('node:events').EventEmitter<ProxyRelayEvents> {
    return this as unknown as import('node:events').EventEmitter<ProxyRelayEvents>
  }

  closeUpstreamConnection (clientAddr: bigint): void {
    const self = this as unknown as RelayInternals
    const key = String(clientAddr)
    self.upstreams.get(key)?.close()
    self.upstreams.delete(key)
  }
}
