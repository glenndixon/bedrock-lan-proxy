// Upstream link to the remote server: NetherNet with HTTP signalling.
//
// A Bedrock 1.26.60+ dedicated server accepts a WebRTC offer over HTTP on its game port
// (POST /v1/join/<clientNetworkId>) and answers with its SDP, signed by the server's
// operator key. Game traffic then flows over WebRTC data channels (UDP).
//
// bedrock-protocol 3.61 can speak NetherNet but only knows LAN and Xbox-services
// signalling, so we give its Client a transport built on node-nethernet's HTTP mode.

import { Client as NethernetClient } from 'nethernet'
import { Client as BedrockClient } from 'bedrock-protocol'
import type { ClientTransport, HttpSignallingOptions, UpstreamClient } from './types/internals.ts'

interface TransportOptions extends HttpSignallingOptions {
  webrtcBackend?: 'werift' | 'wrtc' | 'auto'
  responseTimeoutMs?: number
}

/** Same interface as bedrock-protocol's internal NethernetClient wrapper. */
export class HttpNethernetTransport implements ClientTransport {
  onConnected: ClientTransport['onConnected'] = () => {}
  onCloseConnection: ClientTransport['onCloseConnection'] = () => {}
  onEncapsulated: ClientTransport['onEncapsulated'] = () => {}
  onError: ClientTransport['onError'] = () => {}

  readonly owner: UpstreamClient // the bedrock-protocol Client this transport belongs to
  readonly nethernet: NethernetClient

  constructor (owner: UpstreamClient, { url, serverKey, onServerKey, webrtcBackend, responseTimeoutMs }: TransportOptions) {
    this.owner = owner
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

  connect (): void {
    // The offer must carry an identity: the player's multiplayer token plus a signature
    // from its key. After Xbox sign-in, bedrock-protocol has already set this. In offline
    // mode it only builds its self-signed token at login, after we connect, so build it now.
    if (!this.nethernet.identity) {
      const c = this.owner
      if (!c.multiplayerToken) c.createClientChain(null, true)
      if (!c.multiplayerToken) {
        throw new Error(`Offline login for game version ${c.options.version} has no multiplayer token to sign the NetherNet offer with`)
      }
      this.nethernet.identity = { privateKey: c.ecdhKeyPair.privateKey, token: c.multiplayerToken }
    }
    this.nethernet.connect()
  }

  sendReliable (data: Buffer): void {
    this.nethernet.send(data)
  }

  close (reason?: string): void {
    this.nethernet.close(reason)
  }
}

// bedrock-protocol's Relay creates its upstream Client internally, so hook Client#init:
// when the options ask for HTTP signalling, swap in our transport before connect().
let installed = false
export function installHttpSignalling (): void {
  if (installed) return
  installed = true
  const proto = BedrockClient.prototype as unknown as UpstreamClient
  const originalInit = proto.init
  proto.init = function (this: UpstreamClient) {
    originalInit.call(this)
    const http = this.options.transport === 'nethernet' ? this.options.nethernet?.http : undefined
    if (http && this.connection) {
      try { this.connection.close() } catch {}
      const transport = new HttpNethernetTransport(this, { ...http, webrtcBackend: this.options.nethernet?.webrtcBackend })
      transport.onError = error => this.onConnectionError(error)
      this.connection = transport
    }
  }
}
