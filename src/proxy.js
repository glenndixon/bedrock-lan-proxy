'use strict'

// A LAN-facing NetherNet server that relays each Bedrock client to a remote server.
//
//   Bedrock client ──NetherNet/WebRTC (LAN, UDP 7551)──▶ proxy ──RakNet──▶ remote server
//
// node-nethernet handles LAN discovery, signalling and the WebRTC data channels.
// bedrock-protocol's Relay sits on top of it: it terminates each client's game session
// and opens a matching session to the remote server. Raw byte forwarding is not possible
// because NetherNet sessions have no 0xFE batch header and no game-layer encryption,
// while a RakNet server expects both.

const { EventEmitter } = require('node:events')
const path = require('node:path')
const os = require('node:os')
const { Relay } = require('bedrock-protocol')
const bpOptions = require('bedrock-protocol/src/options')
const initRaknet = require('bedrock-protocol/src/rak')
const { fromServerName } = require('bedrock-protocol/src/server/advertisement')
const { Versions, CURRENT_VERSION } = bpOptions
const MIN_PROTOCOL = Versions[bpOptions.MIN_VERSION] // MIN_VERSION is a version string

const DEFAULT_PROFILES = path.join(os.homedir(), '.bedrock-lan-proxy', 'auth')

/**
 * The upstream link to the remote is RakNet. raknet-native is faster but only ships
 * prebuilt binaries for a few OS versions; jsp-raknet is pure JavaScript and always works.
 */
function pickRaknetBackend (requested = 'auto') {
  if (requested !== 'auto') return requested
  try {
    require('raknet-native')
    return 'raknet-native'
  } catch {
    return 'jsp-raknet'
  }
}

let raknetBackend = pickRaknetBackend()

function useRaknetBackend (name) {
  raknetBackend = pickRaknetBackend(name)
  initRaknet(raknetBackend) // throws now rather than mid-join if the backend can't load
  // Relay doesn't pass raknetBackend through to its upstream Client, which falls back
  // to bedrock-protocol's shared defaults, so set it there.
  bpOptions.defaultOptions.raknetBackend = raknetBackend
  return raknetBackend
}

/** Ask a RakNet Bedrock server for its MOTD, version and player counts. */
async function pingRemote (host, port, timeout = 3000) {
  const { RakClient } = initRaknet(raknetBackend)
  const con = new RakClient({ host, port, useWorkers: false })
  let reply
  try {
    reply = await con.ping(timeout)
  } finally {
    try { con.close() } catch {}
  }
  const ad = fromServerName(Buffer.isBuffer(reply) ? reply.toString() : String(reply))
  return {
    motd: ad.motd,
    levelName: ad.levelName,
    protocol: Number(ad.protocol),
    version: ad.version,
    playersOnline: Number(ad.playersOnline) || 0,
    playersMax: Number(ad.playersMax) || 0,
    gamemodeId: Number(ad.gamemodeId) || 0
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
  if (remote) {
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
      how: `remote reports ${remote.version} (protocol ${remote.protocol}), which bedrock-protocol does not support; using ${CURRENT_VERSION}`,
      warn: true
    }
  }
  return { version: CURRENT_VERSION, how: 'remote did not answer ping; using newest supported', warn: true }
}

function supportedVersions () {
  return Object.keys(Versions).filter(v => Versions[v] >= MIN_PROTOCOL)
}

class LanProxy extends EventEmitter {
  /**
   * @param {object} opts
   * @param {string} opts.host            remote server host
   * @param {number} [opts.port=19132]    remote server port
   * @param {string} [opts.name]          name shown in the Friends/LAN list (default: remote MOTD)
   * @param {string} [opts.levelName]     world name shown under it (default: remote level name)
   * @param {string} [opts.version]       game version (default: auto-detect from remote)
   * @param {boolean} [opts.offline]      connect to the remote without Xbox sign-in
   * @param {string} [opts.bind]          local IPv4 for the LAN discovery socket
   * @param {number} [opts.maxPlayers=10] max simultaneous LAN players
   * @param {string} [opts.profilesFolder] where upstream Microsoft sign-in tokens are cached
   * @param {'werift'|'wrtc'|'auto'} [opts.webrtc] WebRTC backend for node-nethernet
   * @param {'auto'|'raknet-native'|'jsp-raknet'} [opts.raknet='auto'] RakNet backend for the upstream link
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
      refreshSeconds: 15,
      ...opts
    }
    this.remote = null
    this.remoteUp = false
    this.relay = null
    this.players = new Set()
  }

  async start () {
    const o = this.opts

    this.raknetBackend = useRaknetBackend(o.raknet)
    this.emit('debug', `Upstream RakNet backend: ${this.raknetBackend}`)

    try {
      this.remote = await pingRemote(o.host, o.port)
      this.remoteUp = true
      this.emit('remote', this.remote)
    } catch (err) {
      this.emit('warn', `Remote ${o.host}:${o.port} did not answer a ping (${err.message}). Starting anyway.`)
    }

    const { version, how, warn } = resolveVersion(o.version, this.remote)
    this.version = version
    this.emit(warn ? 'warn' : 'info', `Game version ${version} (${how})`)

    let relay
    this.relay = relay = new Relay({
      transport: 'nethernet',
      version,
      host: o.bind, // node-nethernet binds its discovery socket (UDP 7551) here
      maxPlayers: o.maxPlayers,
      nethernet: o.webrtc ? { webrtcBackend: o.webrtc } : {},
      logging: !!o.logPackets,
      // LAN clients still log in to the proxy with their own Xbox accounts. lanOffline
      // also accepts self-signed logins; it exists for automated tests.
      offline: !!o.lanOffline,
      profilesFolder: o.profilesFolder,
      destination: {
        host: o.host,
        port: o.port,
        transport: 'raknet',
        offline: !!o.offline
      },
      advertisementFn: () => this._advertisement(relay),
      onMsaCode: (code, player) => this._onMsaCode(code, player)
    })

    relay.on('connect', player => this._trackPlayer(player))
    relay.on('join', (player) => {
      this.emit('info', `${playerName(player)} is now connected to ${o.host}:${o.port}`)
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
    ad.motd = o.name || (r && r.motd) || `${o.host}`
    ad.levelName = o.levelName || (r && r.levelName) || `${o.host}:${o.port}`
    ad.gamemodeId = r ? r.gamemodeId : 0
    // Show the remote's population so people know who's on; fall back to our own count.
    ad.playerCount = r && this.remoteUp ? r.playersOnline : this.players.size
    ad.playersMax = r && r.playersMax ? r.playersMax : o.maxPlayers
    return ad
  }

  async _refreshRemote () {
    const o = this.opts
    try {
      this.remote = await pingRemote(o.host, o.port)
      if (!this.remoteUp) this.emit('info', `Remote ${o.host}:${o.port} is reachable again`)
      this.remoteUp = true
    } catch (err) {
      if (this.remoteUp) this.emit('warn', `Remote ${o.host}:${o.port} stopped answering pings`)
      this.remoteUp = false
    }
  }

  _trackPlayer (player) {
    this.players.add(player)
    player.on('login', () => this.emit('info', `${playerName(player)} found the LAN game and is signing in`))
    player.on('close', () => {
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

module.exports = { LanProxy, pingRemote, resolveVersion, supportedVersions, useRaknetBackend, DEFAULT_PROFILES }
