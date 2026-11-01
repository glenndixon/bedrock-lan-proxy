// A LAN-facing NetherNet server that relays each Bedrock client to a remote server,
// using NetherNet on both sides:
//
//   Bedrock client ──NetherNet, LAN signalling (UDP 7551)──▶ proxy
//   proxy ──NetherNet, HTTP signalling (TCP game port) + WebRTC (UDP)──▶ remote server
//
// node-nethernet handles discovery, signalling and the WebRTC data channels on both
// sides. bedrock-protocol's Relay terminates each client's game session and opens a
// matching session to the remote as that player. (A login is signed for the server it's
// sent to, so it can't simply be forwarded.)

import { EventEmitter } from 'node:events'
import crypto from 'node:crypto'
import path from 'node:path'
import os from 'node:os'
import { pingHttp } from 'nethernet'
import { Versions, CURRENT_VERSION, MIN_VERSION } from 'bedrock-protocol/src/options.js'
import type { NethernetServerAdvertisement } from 'bedrock-protocol'
import { ProxyRelay } from './relay.ts'
import { installHttpSignalling } from './upstream.ts'
import { installLanFixes } from './lanFixes.ts'
import { createServerTrust } from './trust.ts'
import type { MsaCode, RelayInternals, RelayPlayerInternals } from './types/internals.ts'

const MIN_PROTOCOL = Versions[MIN_VERSION] ?? 0 // MIN_VERSION is a version string

const STATE_DIR = path.join(os.homedir(), '.bedrock-lan-proxy')
export const DEFAULT_PROFILES = path.join(STATE_DIR, 'auth')
export const DEFAULT_TRUST_FILE = path.join(STATE_DIR, 'known_servers.json')
const GAME_TYPES: Record<string, number> = { survival: 0, creative: 1, adventure: 2, spectator: 6 }

installHttpSignalling()
installLanFixes()

export type WebRTCBackend = 'werift' | 'wrtc' | 'auto'

/** What the remote server publishes about itself (GET /v1/join). */
export interface RemoteInfo {
  reachable: true
  motd?: string
  levelName?: string
  protocol?: number
  version?: string
  playersOnline?: number
  playersMax?: number
  gamemodeId?: number
}

export interface VersionChoice {
  version: string
  /** Human-readable reason for the choice. */
  how: string
  /** True when the choice is a fallback the user should know about. */
  warn?: boolean
}

export interface LanProxyOptions {
  /** Remote server host, or an http(s):// URL. */
  host: string
  /** Remote game port (TCP signalling). Default 19132. */
  port?: number
  /** Name shown in the Friends/LAN list. Default: the remote's name. */
  name?: string
  /** World name shown under it. Default: the remote's level name. */
  levelName?: string
  /** Game version to speak. Default: match the remote. */
  version?: string
  /** Join the remote without Xbox sign-in. */
  offline?: boolean
  /** Accept self-signed LAN logins (for automated tests only). */
  lanOffline?: boolean
  /** sha256:<hex> to pin the remote's server key. */
  serverKey?: string
  /** Where first-seen server keys are remembered. */
  trustFile?: string
  /** Local IPv4 for the LAN discovery socket. */
  bind?: string
  /** Max simultaneous LAN players. Default 10. */
  maxPlayers?: number
  /** Where upstream Microsoft sign-in tokens are cached. */
  profilesFolder?: string
  /** WebRTC backend for node-nethernet. */
  webrtc?: WebRTCBackend
  /** How often to re-ping the remote, in seconds. Default 15. */
  refreshSeconds?: number
  /** Log every relayed packet. */
  logPackets?: boolean
}

type ResolvedOptions = LanProxyOptions & Required<Pick<LanProxyOptions, 'port' | 'maxPlayers' | 'profilesFolder' | 'trustFile' | 'refreshSeconds'>>

export interface LanProxyEvents {
  info: [message: string]
  warn: [message: string]
  debug: [message: string]
  error: [error: Error]
  remote: [remote: RemoteInfo]
  auth: [prompt: { player: string, url: string, code: string }]
  listening: [details: { networkId: bigint, version: string }]
}

/** The HTTP signalling origin for a remote: http://host:port, or a URL the user gave. */
export function remoteOrigin (host: string, port: number): string {
  if (/^https?:\/\//i.test(host)) return new URL(host).origin
  const h = host.includes(':') ? `[${host}]` : host // bare IPv6
  return `http://${h}:${port}`
}

/** Ask a NetherNet server for its name, version and player counts (GET /v1/join). */
export async function pingRemote (origin: string, timeout = 3000): Promise<RemoteInfo> {
  const m = await pingHttp(origin, { timeout })
  if (!m.raw) {
    // Reachable, but the server publishes no metadata (BDS with LAN visibility off).
    return { reachable: true }
  }
  const rawGameType: unknown = m.gameType
  const gameType = typeof rawGameType === 'string' ? GAME_TYPES[rawGameType.toLowerCase()] : rawGameType
  return {
    reachable: true,
    motd: m.name,
    levelName: m.level,
    protocol: Number(m.protocol) || undefined,
    version: m.version,
    playersOnline: Number(m.players) || 0,
    playersMax: Number(m.maxPlayers) || 0,
    gamemodeId: Number(gameType) || 0
  }
}

/**
 * Pick the game version the proxy speaks. Clients must be on this version, and so must
 * the remote server, so by default we match whatever the remote reports.
 */
export function resolveVersion (requested: string | undefined, remote: RemoteInfo | null): VersionChoice {
  if (requested) {
    const protocol = Versions[requested]
    if (!protocol || protocol < MIN_PROTOCOL) throw new Error(`Unsupported game version ${requested}. Supported: ${supportedVersions().join(', ')}`)
    return { version: requested, how: 'from --game-version' }
  }
  if (remote?.version || remote?.protocol) {
    const exact = remote.version ? Versions[remote.version] : undefined
    if (remote.version && exact && exact >= MIN_PROTOCOL) {
      return { version: remote.version, how: 'matched remote server' }
    }
    // Servers sometimes report a patch version we don't list; match on protocol number.
    const sameProtocol = Object.keys(Versions).filter(v => Versions[v] === remote.protocol)
    if (sameProtocol[0]) {
      return { version: sameProtocol[0], how: `matched remote protocol ${remote.protocol}` } // Versions is newest-first
    }
    return {
      version: CURRENT_VERSION,
      how: `remote reports ${remote.version ?? '?'} (protocol ${remote.protocol ?? '?'}), which bedrock-protocol does not support; using ${CURRENT_VERSION}`,
      warn: true
    }
  }
  const why = remote ? 'remote publishes no version' : 'remote did not answer'
  return { version: CURRENT_VERSION, how: `${why}; using newest supported`, warn: true }
}

export function supportedVersions (): string[] {
  return Object.keys(Versions).filter(v => (Versions[v] ?? 0) >= MIN_PROTOCOL)
}

export class LanProxy extends EventEmitter<LanProxyEvents> {
  readonly opts: ResolvedOptions
  readonly origin: string
  remote: RemoteInfo | null = null
  remoteUp = false
  relay: ProxyRelay | null = null
  version?: string
  networkId?: bigint
  private readonly players = new Set<RelayPlayerInternals>()
  // Dedicated servers put a random 16-hex-digit nonce in their LAN advertisement.
  private readonly nonce = crypto.randomBytes(8).toString('hex')
  private refreshTimer?: NodeJS.Timeout
  private adLogged = false

  constructor (opts: LanProxyOptions) {
    super()
    if (!opts.host) throw new Error('A remote host is required')
    this.opts = {
      ...opts,
      port: opts.port ?? 19132,
      maxPlayers: opts.maxPlayers ?? 10,
      profilesFolder: opts.profilesFolder ?? DEFAULT_PROFILES,
      trustFile: opts.trustFile ?? DEFAULT_TRUST_FILE,
      refreshSeconds: opts.refreshSeconds ?? 15
    }
    this.origin = remoteOrigin(this.opts.host, this.opts.port)
  }

  async start (): Promise<void> {
    const o = this.opts

    try {
      this.remote = await pingRemote(this.origin)
      this.remoteUp = true
      this.emit('remote', this.remote)
    } catch (err) {
      const e = err as Error & { cause?: { code?: string } }
      this.emit('warn', `Remote ${this.origin} did not answer (${e.cause?.code || e.message}). Starting anyway.`)
    }

    const { version, how, warn } = resolveVersion(o.version, this.remote)
    this.version = version
    this.emit(warn ? 'warn' : 'info', `Game version ${version} (${how})`)

    const trust = createServerTrust({
      file: o.trustFile,
      pinned: o.serverKey,
      log: (level, msg) => this.emit(level, msg)
    })

    // Annotated because advertisementFn below refers back to `relay`: without it,
    // TypeScript 5/6 can't infer the type through that self-reference (TS7022).
    const relay: ProxyRelay = new ProxyRelay({
      transport: 'nethernet',
      version,
      host: o.bind, // node-nethernet binds its LAN discovery socket (UDP 7551) here
      maxPlayers: o.maxPlayers,
      nethernet: o.webrtc ? { webrtcBackend: o.webrtc } : {},
      logging: !!o.logPackets,
      // LAN clients still log in to the proxy with their own Xbox accounts. lanOffline
      // also accepts self-signed logins; it exists for automated tests.
      offline: !!o.lanOffline,
      profilesFolder: o.profilesFolder,
      destination: {
        transport: 'nethernet',
        offline: !!o.offline,
        nethernet: {
          signalling: 'http',
          // bedrock-protocol insists on a remote network ID; with HTTP signalling the URL
          // identifies the server and this value is unused.
          networkId: 1n,
          webrtcBackend: o.webrtc,
          http: { url: this.origin, ...trust }
        }
      },
      advertisementFn: () => this.advertisement(relay),
      onMsaCode: (code, player) => this.onMsaCode(code, player)
    })
    this.relay = relay

    const events = relay.events
    events.on('connect', player => this.trackPlayer(player))
    events.on('join', player => {
      this.emit('info', `${playerName(player)} is now connected to ${this.origin}`)
    })
    events.on('upstreamKick', (player, packet) => {
      this.emit('warn', `${this.origin} disconnected ${playerName(player)}: ${packet.message || '(no reason given)'}`)
    })
    events.on('subClientLogin', (player, sub) => {
      this.emit('info', `Split-screen player ${sub} is joining alongside ${playerName(player)}`)
    })
    events.on('subClientStatus', (player, sub, status) => {
      this.emit('debug', `Split-screen player ${sub} (with ${playerName(player)}): ${status}`)
    })
    events.on('subClientKick', (player, sub, packet) => {
      this.emit('warn', `${this.origin} disconnected split-screen player ${sub} (with ${playerName(player)}): ${packet?.message || '(no reason given)'}`)
    })
    events.on('upstreamCancelled', (player) => {
      this.emit('debug', `${playerName(player)} left before reaching ${this.origin}; cancelled their upstream connection`)
    })
    events.on('error', err => this.emit('error', err))

    await relay.listen()
    this.networkId = (relay as unknown as RelayInternals).transport.nethernet.networkId
    this.refreshTimer = setInterval(() => { void this.refreshRemote() }, o.refreshSeconds * 1000)
    this.refreshTimer.unref()
    this.emit('listening', { networkId: this.networkId, version })
  }

  private advertisement (relay: ProxyRelay): NethernetServerAdvertisement {
    const o = this.opts
    const r = this.remote
    const ad = (relay as unknown as RelayInternals).advertisement
    ad.motd = o.name || r?.motd || o.host
    ad.levelName = o.levelName || r?.levelName || this.origin.replace(/^https?:\/\//, '')
    ad.gamemodeId = r?.gamemodeId ?? 0
    // Show the remote's population so people know who's on; fall back to our own count.
    ad.playerCount = r?.playersMax && this.remoteUp ? r.playersOnline ?? 0 : this.players.size
    ad.playersMax = r?.playersMax || o.maxPlayers
    ad.nonce = this.nonce
    if (!this.adLogged) {
      this.adLogged = true
      this.emit('debug', `LAN advertisement: ${JSON.stringify({ ...ad, raw: undefined })}`)
    }
    return ad
  }

  private async refreshRemote (): Promise<void> {
    try {
      this.remote = await pingRemote(this.origin)
      if (!this.remoteUp) this.emit('info', `Remote ${this.origin} is reachable again`)
      this.remoteUp = true
    } catch {
      if (this.remoteUp) this.emit('warn', `Remote ${this.origin} stopped answering`)
      this.remoteUp = false
    }
  }

  private trackPlayer (player: RelayPlayerInternals): void {
    this.players.add(player)
    const addr = player.connection?.address
    this.emit('debug', `LAN connection ${addr} open (WebRTC data channels up), waiting for login`)
    player.on('loggingIn', () => this.emit('debug', `LAN connection ${addr} sent login`))
    player.on('login', () => this.emit('info', `${playerName(player)} found the LAN game and is signing in`))
    player.on('join', () => this.emit('debug', `${playerName(player)} logged in to the proxy; connecting upstream to ${this.origin}`))
    player.on('close', (reason?: string) => {
      this.emit('debug', `LAN connection ${addr} closed${reason ? `: ${reason}` : ''}`)
      if (this.players.delete(player)) this.emit('info', `${playerName(player)} left`)
    })
  }

  private onMsaCode (code: MsaCode, player: RelayPlayerInternals): void {
    // The remote needs this player signed in to Xbox Live as themselves. The proxy
    // can't reuse the LAN client's login, so it does a one-time device sign-in per
    // player and caches the token in profilesFolder.
    const who = playerName(player)
    this.emit('auth', { player: who, url: code.verification_uri, code: code.user_code })
    player.disconnect(signInMessage(this.opts.host, code))
  }

  async stop (reason = 'Proxy shutting down'): Promise<void> {
    clearInterval(this.refreshTimer)
    if (this.relay) await this.relay.close(reason)
  }
}

/**
 * What a player sees when they're sent off to sign in. Plain text only: the disconnect
 * screen shows Minecraft's § formatting codes literally instead of applying them.
 */
export function signInMessage (host: string, code: MsaCode): string {
  return `First time through this proxy: sign in to let it join ${host} as you.\n\n` +
    `Go to ${code.verification_uri} and enter this code:\n\n` +
    `${code.user_code}\n\n` +
    'Then reconnect from the Friends tab.'
}

function playerName (player: RelayPlayerInternals | undefined): string {
  return player?.profile?.name || player?.connection?.address?.toString() || 'A player'
}
