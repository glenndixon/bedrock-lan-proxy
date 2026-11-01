// --debug: write a detailed trace of every connection step to a log file, so a failed
// join can be diagnosed afterwards. Covers LAN signalling in and out, WebRTC/ICE state,
// logins and kicks (via the libraries' own debug output), and the upstream connection.

import fs from 'node:fs'
import util from 'node:util'
import path from 'node:path'
import type { RemoteInfo } from 'node:dgram'
import { createRequire } from 'node:module'
import type { Debug } from 'debug'
import { Server, Client as NethernetClient, SignalType } from 'nethernet'
import type { SignalStructure } from 'nethernet'
import type { DiscoveryMessagePacket, SignalResponder, WatchablePeer } from './types/internals.ts'

const require = createRequire(import.meta.url)

const NAMESPACES = [
  'nethernet',
  'minecraft-protocol',
  'bedrock-protocol*',
  'prismarine-auth*',
  'werift-ice*',
  'werift:packages/webrtc/src/peerConnection.ts',
  'werift:packages/webrtc/src/transport/ice.ts',
  'werift:packages/webrtc/src/transport/dtls.ts',
  'werift:packages/webrtc/src/transport/sctpManager.ts',
  'werift:packages/webrtc/src/dataChannel.ts'
].join(',')

export type TraceWriter = (...args: unknown[]) => void

export interface Diagnostics {
  write: TraceWriter
  file: string
}

/** The debug module's Node build also has useColors(); @types/debug omits it. */
type NodeDebug = Debug & { useColors?: () => boolean }

// werift ships its own copy of the debug module, so configure every copy.
function debugModules (): NodeDebug[] {
  const mods = new Set<NodeDebug>([require('debug') as NodeDebug])
  for (const from of ['werift', 'nethernet', 'bedrock-protocol']) {
    try {
      const dir = path.dirname(require.resolve(from))
      mods.add(require(require.resolve('debug', { paths: [dir] })) as NodeDebug)
    } catch {}
  }
  return [...mods]
}

function summarize (s: SignalStructure | undefined): string {
  if (!s) return ''
  if (s.type === SignalType.CandidateAdd) return s.data
  if (s.type === SignalType.ConnectRequest || s.type === SignalType.ConnectResponse) {
    // Keep the lines that matter for ICE/DTLS; full SDPs are long.
    const keep = String(s.data).split(/\r?\n/).filter(l => /^a=(candidate|ice-|setup|fingerprint|group|identity)/.test(l))
    return keep.map(l => l.startsWith('a=identity:') ? 'a=identity:<present>' : l).join(' | ')
  }
  return s.data
}

/** Internal fields of node-nethernet's Client used to find its peer connection. */
interface ClientInternals {
  rtcConnection?: WatchablePeer | null
  _closed?: boolean
  createOffer (): Promise<void>
}

export function startDiagnostics (file: string): Diagnostics {
  const out = fs.createWriteStream(file, { flags: 'a' })
  const write: TraceWriter = (...args) => out.write(`${new Date().toISOString()} ${util.format(...args)}\n`)
  write('==== bedrock-lan-proxy debug session started', process.version, process.platform, process.arch)

  for (const debug of debugModules()) {
    debug.log = (...args: unknown[]) => write(...args)
    if (debug.inspectOpts) debug.inspectOpts.hideDate = true // write() adds the timestamp
    debug.useColors = () => false
    debug.enable(NAMESPACES)
  }

  // LAN signalling, incoming
  const handleMessage = Server.prototype.handleMessage
  Server.prototype.handleMessage = function (this: Server, packet: DiscoveryMessagePacket, rinfo: RemoteInfo) {
    const data = packet?.params?.data
    if (data && data !== 'Ping') {
      write(`LAN in  from ${rinfo.address}:${rinfo.port} sender=${packet.params?.sender_id} recipient=${packet.params?.recipient_id}`,
        data.length > 160 ? data.slice(0, 40) + '…' : data)
    }
    return handleMessage.call(this, packet, rinfo)
  }

  // LAN signalling, outgoing, plus WebRTC state for each incoming connection
  const handleOffer = Server.prototype.handleOffer
  Server.prototype.handleOffer = function (this: Server, signal: SignalStructure, respond: SignalResponder, ...rest: unknown[]) {
    write(`LAN offer connection=${signal.connectionId} from network id ${signal.networkId}:`, summarize(signal))
    const logged: SignalResponder = (s) => {
      write(`LAN out ${s.type} connection=${s.connectionId}:`, summarize(s))
      return respond(s)
    }
    const result = (handleOffer as (...a: unknown[]) => Promise<void>).call(this, signal, logged, ...rest)
    const conn = this.connections.get(signal.connectionId)
    if (conn) watchPeer(`downstream ${signal.connectionId}`, conn.rtcConnection as unknown as WatchablePeer, write)
    return result
  }

  // Upstream (proxy → remote) WebRTC state
  const clientProto = NethernetClient.prototype as unknown as ClientInternals
  const createOffer = clientProto.createOffer
  clientProto.createOffer = function (this: ClientInternals) {
    const result = createOffer.call(this)
    // rtcConnection is created after an await inside createOffer; catch it as soon as it exists.
    const poll = setInterval(() => {
      if (this.rtcConnection || this._closed) {
        clearInterval(poll)
        if (this.rtcConnection) watchPeer('upstream', this.rtcConnection, write)
      }
    }, 5)
    void Promise.resolve(result).finally(() => setTimeout(() => clearInterval(poll), 50))
    return result
  }

  process.on('exit', () => write('==== session ended'))
  return { write, file }
}

const watched = new WeakSet<WatchablePeer>()

// Watch a peer connection's state without touching the on* handlers node-nethernet uses.
function watchPeer (label: string, pc: WatchablePeer | null | undefined, write: TraceWriter): void {
  if (!pc || watched.has(pc)) return
  watched.add(pc)
  const events = [
    ['connectionStateChange', 'connectionstatechange', () => `connection=${pc.connectionState}`],
    ['iceConnectionStateChange', 'iceconnectionstatechange', () => `ice=${pc.iceConnectionState}`],
    ['iceGatheringStateChange', 'icegatheringstatechange', () => `gathering=${pc.iceGatheringState}`]
  ] as const
  for (const [weriftEvent, domEvent, read] of events) {
    const subscribable = pc[weriftEvent]
    if (subscribable) subscribable.subscribe(() => write(`${label} ${read()}`)) // werift
    else pc.addEventListener?.(domEvent, () => write(`${label} ${read()}`)) // native wrtc
  }
  write(`${label} watching: ${events.map(([, , read]) => read()).join(' ')}`)
}
