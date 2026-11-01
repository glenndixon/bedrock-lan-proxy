// Types for the parts of bedrock-protocol and node-nethernet the proxy uses that aren't in
// their published typings: internal fields and methods it reads, wraps or patches.
// Kept deliberately narrow: only what this project touches.

import type { EventEmitter } from 'node:events'
import type { KeyObject } from 'node:crypto'
import type { SignalStructure } from 'nethernet'
import type { Connection as BedrockConnection } from 'bedrock-protocol/src/connection.js'
import type { NethernetServer } from 'bedrock-protocol/src/nethernet/index.js'

// ---------------------------------------------------------------------------------------
// Packets

/** A decoded game packet, as returned by bedrock-protocol's deserializer. */
export interface ParsedPacket {
  data: { name: string, params: Record<string, unknown> }
  canceled?: boolean
}

export interface PacketDeserializer {
  parsePacketBuffer (buffer: Buffer): ParsedPacket
}

export interface PacketSerializer {
  createPacketBuffer (packet: { name: string, params: object }): Buffer
}

/** Fields of the disconnect packet (server → client). */
export interface DisconnectParams {
  reason?: string
  hide_disconnect_reason?: boolean
  message?: string
  filtered_message?: string
}

// ---------------------------------------------------------------------------------------
// Transports: what bedrock-protocol's Client and Server expect from a NetherNet/RakNet layer

export interface ClientTransport {
  onConnected: (connection: unknown) => void
  onCloseConnection: (reason: unknown) => void
  onEncapsulated: (packet: { buffer: Buffer }, address: bigint) => void
  onError: (error: Error) => void
  connect (): Promise<void> | void
  sendReliable (data: Buffer): void
  close (reason?: string): void
}

/** Server-side transport wrapper (bedrock-protocol/src/nethernet NethernetServer). */
export type ServerTransport = NethernetServer

// ---------------------------------------------------------------------------------------
// HTTP signalling options carried through bedrock-protocol's nethernet options

export interface HttpSignallingOptions {
  url: string
  serverKey?: string
  onServerKey?: (fingerprint: string, origin: string) => boolean | Promise<boolean>
}

export interface UpstreamNethernetOptions {
  signalling?: 'lan' | 'services' | 'http'
  networkId?: bigint | string
  webrtcBackend?: 'werift' | 'wrtc' | 'auto'
  http?: HttpSignallingOptions
}

// ---------------------------------------------------------------------------------------
// bedrock-protocol connections

/** Fields shared by bedrock-protocol's Client and server-side Player (src/connection.js). */
export interface ConnectionInternals extends EventEmitter, BedrockConnection {
  write (name: string, params: object): void
  queue (name: string, params: object): void
  sendBuffer (buffer: Buffer, immediate?: boolean): void
  readPacket (packet: Buffer): void
  _processOutbound (name: string, params: unknown): void
}

/** bedrock-protocol Client (the proxy's upstream connection to the remote). */
export interface UpstreamClient extends ConnectionInternals {
  options: {
    version: string
    transport?: 'raknet' | 'nethernet'
    nethernet?: UpstreamNethernetOptions
    skinData?: unknown
  }
  connection?: ClientTransport
  multiplayerToken?: string
  ecdhKeyPair: { privateKey: KeyObject }
  noLoginForward?: boolean
  outLog?: (...args: unknown[]) => void
  inLog?: (...args: unknown[]) => void
  init (): void
  connect (): void
  close (reason?: string): void
  createClientChain (mojangKey: string | null, offline: boolean): void
  onConnectionError (error: Error): void
}

/** A LAN player connected to the proxy (bedrock-protocol's RelayPlayer). */
export interface RelayPlayerInternals extends ConnectionInternals {
  server: RelayInternals
  connection?: { address: bigint }
  profile?: { name: string, xuid: string, uuid: string }
  skinData?: unknown
  status: number
  _closed?: boolean
  startRelaying: boolean
  upstream?: UpstreamClient
  upQ: Buffer[]
  downQ: Buffer[]
  chunkSendCache: Buffer[]
  sentStartGame: boolean
  upInLog: (...args: unknown[]) => void
  upOutLog: (...args: unknown[]) => void
  downInLog: (...args: unknown[]) => void
  readUpstream (packet: Buffer): void
  flushUpQueue (): void
  flushDownQueue (): void
  disconnect (reason: string, hide?: boolean): void
}

export type RelayPlayerClass = new (server: unknown, connection: unknown) => RelayPlayerInternals

/** Device-code prompt from prismarine-auth. */
export interface MsaCode {
  user_code: string
  verification_uri: string
  message?: string
}

/** bedrock-protocol's Relay (a Server that also opens upstream connections). */
export interface RelayInternals extends EventEmitter {
  options: {
    version: string
    offline?: boolean
    authTitle?: string
    flow?: string
    deviceType?: string
    batchingInterval?: number
    profilesFolder?: string | false
    onMsaCode?: (code: MsaCode, player: RelayPlayerInternals) => void
    destination: {
      host?: string
      port?: number
      offline?: boolean
      transport?: 'raknet' | 'nethernet'
      nethernet?: UpstreamNethernetOptions
    }
  }
  RelayPlayer: RelayPlayerClass
  upstreams: Map<string, UpstreamClient>
  enableChunkCaching?: boolean
  conLog: (...args: unknown[]) => void
  deserializer: PacketDeserializer
  serializer: PacketSerializer
  advertisement: import('bedrock-protocol').NethernetServerAdvertisement
  transport: ServerTransport
  clients: Record<string, RelayPlayerInternals>
  clientCount: number
}

// ---------------------------------------------------------------------------------------
// node-nethernet internals

export type SignalResponder = (signal: SignalStructure) => void

/** A WebRTC peer connection; werift exposes subscribable state events, wrtc DOM events. */
export interface WatchablePeer {
  connectionState: string
  iceConnectionState: string
  iceGatheringState: string
  localDescription: { sdp: string } | null
  connectionStateChange?: { subscribe (fn: () => void): unknown }
  iceConnectionStateChange?: { subscribe (fn: () => void): unknown }
  iceGatheringStateChange?: { subscribe (fn: () => void): unknown }
  addEventListener?: (event: string, fn: () => void) => void
}

/** A discovery_message packet as node-nethernet's Server.handleMessage receives it. */
export interface DiscoveryMessagePacket {
  params?: { sender_id: bigint, recipient_id: bigint, data?: string }
}
