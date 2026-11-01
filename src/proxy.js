'use strict'

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

const { EventEmitter } = require('node:events')
const crypto = require('node:crypto')
const path = require('node:path')
const os = require('node:os')
const { ProxyRelay } = require('./relay')
const { pingHttp } = require('nethernet')
const bpOptions = require('bedrock-protocol/src/options')
const { installHttpSignalling } = require('./upstream')
const { installLanFixes } = require('./lanFixes')
const { createServerTrust } = require('./trust')

const { Versions, CURRENT_VERSION } = bpOptions
const MIN_PROTOCOL = Versions[bpOptions.MIN_VERSION] // MIN_VERSION is a version string

const STATE_DIR = path.join(os.homedir(), '.bedrock-lan-proxy')
const DEFAULT_PROFILES = path.join(STATE_DIR, 'auth')
const DEFAULT_TRUST_FILE = path.join(STATE_DIR, 'known_servers.json')
const GAME_TYPES = { survival: 0, creative: 1, adventure: 2, spectator: 6 }

installHttpSignalling()
installLanFixes()

/** The HTTP signalling origin for a remote: http://host:port, or a URL the user gave. */
function remoteOrigin (host, port) {
  if (/^https?:\/\//i.test(host)) return new URL(host).origin
  const h = host.includes(':') ? `[${host}]` : host // bare IPv6
  return `http://${h}:${port}`
}

/** Ask a NetherNet server for its name, version and player counts (GET /v1/join). */
async function pingRemote (origin, timeout = 3000) {
  const m = await pingHttp(origin, { timeout })
  if (!m.raw) {
    // Reachable, but the server publishes no metadata (BDS with LAN visibility off).
    return { reachable: true }
  }
  const gameType = typeof m.gameType === 'string' ? GAME_TYPES[m.gameType.toLowerCase()] : m.gameType
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
function resolveVersion (requested, remote) {
  if (requested) {
    if (!Versions[requested] || Versions[requested] < MIN_PROTOCOL) throw new Error(`Unsupported game version ${requested}. Supported: ${supportedVersions().join(', ')}`)
    return { version: requested, how: 'from --game-version' }
  }
  if (remote?.version || remote?.protocol) {
    if (Versions[remote.version] && Versions[remote.version] >= MIN_PROTOCOL) {
      return { version: remote.version, how: 'matched remote server' }
    }
    // Servers sometimes report a patch version we don't list; match on protocol number.
    const sameProtocol = Object.keys(Versions).filter(v => Versions[v] === remote.protocol)
    if (sameProtocol.length) {
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

function supportedVersions () {
  return Object.keys(Versions).filter(v => Versions[v] >= MIN_PROTOCOL)
}

class LanProxy extends EventEmitter {
  /**
   * @param {object} opts
   * @param {string} opts.host            remote server host or http(s):// URL
   * @param {number} [opts.port=19132]    remote game port (TCP signalling)
   * @param {string} [opts.name]          name shown in the Friends/LAN list (default: remote's name)
   * @param {string} [opts.levelName]     world name shown under it (default: remote's level)
   * @param {string} [opts.version]       game version (default: auto-detect from remote)
   * @param {boolean} [opts.offline]      connect to the remote without Xbox sign-in
   * @param {string} [opts.serverKey]     sha256:<hex> to pin the remote's server key
   * @param {string} [opts.trustFile]     where first-seen server keys are remembered
   * @param {string} [opts.bind]          local IPv4 for the LAN discovery socket
   * @param {number} [opts.maxPlayers=10] max simultaneous LAN players
   * @param {string} [opts.profilesFolder] where upstream Microsoft sign-in tokens are cached
   * @param {'werift'|'wrtc'|'auto'} [opts.webrtc] WebRTC backend for node-nethernet
   * @param {number} [opts.refreshSeconds=15] how often to re-ping the remote
   * @param {boolean} [opts.logPackets] log every relayed packet
   */
  constructor (opts) {
    super()
    if (!opts.host) throw new Error('A remote host is required')
    this.opts = {
      port: 19132,
      maxPlayers: 10,
      profilesFolder: DEFAULT_PROFILES,
      trustFile: DEFAULT_TRUST_FILE,
      refreshSeconds: 15,
      ...opts
    }
    this.origin = remoteOrigin(this.opts.host, this.opts.port)
    this.remote = null
    this.remoteUp = false
    this.relay = null
    this.players = new Set()
    // Dedicated servers put a random 16-hex-digit nonce in their LAN advertisement.
    this.nonce = crypto.randomBytes(8).toString('hex')
  }

  async start () {
    const o = this.opts

    try {
      this.remote = await pingRemote(this.origin)
      this.remoteUp = true
      this.emit('remote', this.remote)
    } catch (err) {
      this.emit('warn', `Remote ${this.origin} did not answer (${err.cause?.code || err.message}). Starting anyway.`)
    }

    const { version, how, warn } = resolveVersion(o.version, this.remote)
    this.version = version
    this.emit(warn ? 'warn' : 'info', `Game version ${version} (${how})`)

    const trust = createServerTrust({
      file: o.trustFile,
      pinned: o.serverKey,
      log: (level, msg) => this.emit(level, msg)
    })

    let relay
    this.relay = relay = new ProxyRelay({
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
      advertisementFn: () => this._advertisement(relay),
      onMsaCode: (code, player) => this._onMsaCode(code, player)
    })

    relay.on('connect', player => this._trackPlayer(player))
    relay.on('join', (player) => {
      this.emit('info', `${playerName(player)} is now connected to ${this.origin}`)
    })
    relay.on('upstreamKick', (player, packet) => {
      this.emit('warn', `${this.origin} disconnected ${playerName(player)}: ${packet.message || '(no reason given)'}`)
    })
    relay.on('subClientLogin', (player, sub) => {
      this.emit('info', `Split-screen player ${sub} is joining alongside ${playerName(player)}`)
    })
    relay.on('subClientStatus', (player, sub, status) => {
      this.emit('debug', `Split-screen player ${sub} (with ${playerName(player)}): ${status}`)
    })
    relay.on('subClientKick', (player, sub, packet) => {
      this.emit('warn', `${this.origin} disconnected split-screen player ${sub} (with ${playerName(player)}): ${packet?.message || '(no reason given)'}`)
    })
    relay.on('upstreamCancelled', (player) => {
      this.emit('debug', `${playerName(player)} left before reaching ${this.origin}; cancelled their upstream connection`)
    })
    relay.on('error', err => this.emit('error', err))

    await relay.listen()
    this.networkId = relay.transport.nethernet.networkId
    this._refresh = setInterval(() => this._refreshRemote(), o.refreshSeconds * 1000)
    this._refresh.unref()
    this.emit('listening', { networkId: this.networkId, version })
  }

  _advertisement (relay) {
    const o = this.opts
    const r = this.remote
    const ad = relay.advertisement // a NethernetServerAdvertisement created by bedrock-protocol
    ad.motd = o.name || r?.motd || o.host
    ad.levelName = o.levelName || r?.levelName || this.origin.replace(/^https?:\/\//, '')
    ad.gamemodeId = r?.gamemodeId ?? 0
    // Show the remote's population so people know who's on; fall back to our own count.
    ad.playerCount = r?.playersMax && this.remoteUp ? r.playersOnline : this.players.size
    ad.playersMax = r?.playersMax || o.maxPlayers
    ad.nonce = this.nonce
    if (!this._adLogged) {
      this._adLogged = true
      this.emit('debug', `LAN advertisement: ${JSON.stringify({ ...ad, raw: undefined })}`)
    }
    return ad
  }

  async _refreshRemote () {
    try {
      this.remote = await pingRemote(this.origin)
      if (!this.remoteUp) this.emit('info', `Remote ${this.origin} is reachable again`)
      this.remoteUp = true
    } catch {
      if (this.remoteUp) this.emit('warn', `Remote ${this.origin} stopped answering`)
      this.remoteUp = false
    }
  }

  _trackPlayer (player) {
    this.players.add(player)
    const addr = player.connection?.address
    this.emit('debug', `LAN connection ${addr} open (WebRTC data channels up), waiting for login`)
    player.on('loggingIn', () => this.emit('debug', `LAN connection ${addr} sent login`))
    player.on('login', () => this.emit('info', `${playerName(player)} found the LAN game and is signing in`))
    player.on('join', () => this.emit('debug', `${playerName(player)} logged in to the proxy; connecting upstream to ${this.origin}`))
    player.on('close', (reason) => {
      this.emit('debug', `LAN connection ${addr} closed${reason ? `: ${reason}` : ''}`)
      if (this.players.delete(player)) this.emit('info', `${playerName(player)} left`)
    })
  }

  _onMsaCode (code, player) {
    // The remote needs this player signed in to Xbox Live as themselves. The proxy
    // can't reuse the LAN client's login, so it does a one-time device sign-in per
    // player and caches the token in profilesFolder.
    const who = playerName(player)
    this.emit('auth', { player: who, url: code.verification_uri, code: code.user_code })
    player.disconnect(
      `First time through this proxy: sign in to let it join ${this.opts.host} as you.\n\n` +
      `Go to ${code.verification_uri} and enter code §l${code.user_code}§r\n\n` +
      'Then reconnect from the Friends tab.'
    )
  }

  async stop (reason = 'Proxy shutting down') {
    clearInterval(this._refresh)
    if (this.relay) await this.relay.close(reason)
  }
}

function playerName (player) {
  return player?.profile?.name || player?.connection?.address?.toString() || 'A player'
}

module.exports = {
  LanProxy,
  pingRemote,
  remoteOrigin,
  resolveVersion,
  supportedVersions,
  DEFAULT_PROFILES,
  DEFAULT_TRUST_FILE
}
