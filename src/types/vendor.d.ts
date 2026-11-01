// Declarations for internal modules of bedrock-protocol and node-nethernet that ship no
// typings. Only the exports and members this project uses are declared. (Module
// declarations can't import relative paths, so shapes are written out here; the
// project's own interfaces in internals.ts build on these.)

declare module 'bedrock-protocol/src/options.js' {
  /** Game version string → protocol number, newest first. */
  export const Versions: Record<string, number>
  export const CURRENT_VERSION: string
  /** Oldest supported game version (a version string, not a protocol number). */
  export const MIN_VERSION: string
}

declare module 'bedrock-protocol/src/connection.js' {
  /** Base class of bedrock-protocol's Client and server-side Player. */
  export class Connection {
    sendQ: Buffer[]
    sendIds: string[]
    encryptionEnabled: boolean
    sendEncryptedBatch (batch: unknown): void
    sendDecryptedBatch (batch: unknown): void
    /** Flushes sendQ as one batch; runs every batchingInterval ms. */
    _tick (): void
  }
}

declare module 'bedrock-protocol/src/transforms/framer.js' {
  export class Framer {
    constructor (connection: unknown)
    addEncodedPacket (packet: Buffer): void
    addEncodedPackets (packets: Buffer[]): void
  }
}

declare module 'bedrock-protocol/src/nethernet/index.js' {
  import type { NethernetServerAdvertisement } from 'bedrock-protocol'
  import type { Server } from 'nethernet'

  /** LAN-discovery client wrapper used by bedrock-protocol. */
  export class NethernetClient {
    constructor (options?: { networkId?: bigint, host?: string, webrtcBackend?: string })
    ping (timeout?: number): Promise<NethernetServerAdvertisement & { networkId: bigint }>
    close (): void
  }

  /** Server transport wrapper used by bedrock-protocol's Server. */
  export class NethernetServer {
    constructor (options: { maxPlayers?: number }, server: unknown)
    nethernet: Server
    onOpenConnection: (connection: unknown) => void
    onCloseConnection: (connection: unknown, reason?: string) => void
    onEncapsulated: (data: Buffer, address: bigint) => void
  }
}

declare module 'nethernet/src/connection.js' {
  export class Connection {
    /** Splits a message into NetherNet segments and sends them on the reliable channel. */
    sendNow (data: Buffer): number
  }
}

declare module 'nethernet/src/webrtc.js' {
  export interface PeerConnection {
    connectionState: string
    iceConnectionState: string
    iceGatheringState: string
    localDescription: { sdp: string } | null
    createDataChannel (label: string, options?: { ordered?: boolean, maxRetransmits?: number }): unknown
    createOffer (): Promise<{ type: 'offer', sdp: string }>
    setLocalDescription (description: { type: 'offer' | 'answer', sdp: string }): Promise<void>
    close (): Promise<void> | void
  }

  export function getWebRTC (backend?: 'werift' | 'wrtc' | 'auto'): {
    RTCPeerConnection: new (config: { iceServers: unknown[] }) => PeerConnection
  }
}

declare module 'nethernet/src/signalling/sdpIdentity.js' {
  import type { KeyObject } from 'node:crypto'
  /** Add a signed a=identity line to an SDP. */
  export function attachIdentity (sdp: string, identity: { privateKey: KeyObject, token: string, domain?: string }): string
}
