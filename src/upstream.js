'use strict'

// Upstream link to the remote server: NetherNet with HTTP signalling.
//
// A Bedrock 1.26.60+ dedicated server accepts a WebRTC offer over HTTP on its game port
// (POST /v1/join/<clientNetworkId>) and answers with its SDP, signed by the server's
// operator key. Game traffic then flows over WebRTC data channels (UDP).
//
// bedrock-protocol 3.61 can speak NetherNet but only knows LAN and Xbox-services
// signalling, so we give its Client a transport built on node-nethernet's HTTP mode.

const { Client: NethernetClient } = require('nethernet')
const { Client: BedrockClient } = require('bedrock-protocol')

/** Same interface as bedrock-protocol's internal NethernetClient wrapper. */
class HttpNethernetTransport {
  constructor (owner, { url, serverKey, onServerKey, webrtcBackend, responseTimeoutMs }) {
    this.owner = owner // the bedrock-protocol Client this transport belongs to
    this.onConnected = () => {}
    this.onCloseConnection = () => {}
    this.onEncapsulated = () => {}
    this.onError = () => {}

    // Remote network ID is 0n because the URL, not LAN discovery, identifies the server.
    this.nethernet = new NethernetClient(0n, undefined, {
      http: { url, serverKey, onServerKey },
      webrtcBackend,
      responseTimeoutMs
    })
    this.nethernet.on('connected', conn => this.onConnected(conn))
    this.nethernet.on('error', err => this.onError(err))
    this.nethernet.on('disconnect', (id, reason) => this.onCloseConnection(reason ?? id))
    this.nethernet.on('encapsulated', (data, id) => this.onEncapsulated({ buffer: data }, id))
  }

  connect () {
    // The offer must carry an identity: the player's multiplayer token plus a signature
    // from its key. After Xbox sign-in, bedrock-protocol has already set this. In offline
    // mode it only builds its self-signed token at login, after we connect, so build it now.
    if (!this.nethernet.identity) {
      const c = this.owner
      if (!c.multiplayerToken) c.createClientChain(null, true)
      if (!c.multiplayerToken) throw new Error(`Offline login for game version ${c.options.version} has no multiplayer token to sign the NetherNet offer with`)
      this.nethernet.identity = { privateKey: c.ecdhKeyPair.privateKey, token: c.multiplayerToken }
    }
    return this.nethernet.connect()
  }

  sendReliable (data) {
    this.nethernet.send(data)
  }

  close (reason) {
    this.nethernet.close(reason)
  }
}

// bedrock-protocol's Relay creates its upstream Client internally, so hook Client#init:
// when the options ask for HTTP signalling, swap in our transport before connect().
let installed = false
function installHttpSignalling () {
  if (installed) return
  installed = true
  const originalInit = BedrockClient.prototype.init
  BedrockClient.prototype.init = function (...args) {
    const result = originalInit.apply(this, args)
    const http = this.options.transport === 'nethernet' && this.options.nethernet?.http
    if (http && this.connection) {
      try { this.connection.close() } catch {}
      this.connection = new HttpNethernetTransport(this, {
        ...http,
        webrtcBackend: this.options.nethernet.webrtcBackend
      })
      this.connection.onError = error => this.onConnectionError(error)
    }
    return result
  }
}

module.exports = { HttpNethernetTransport, installHttpSignalling }
