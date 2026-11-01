// Adjustments so real Minecraft clients (Xbox, Switch, phones...) can join over LAN
// signalling. node-nethernet's own client is more forgiving than the real game, so
// these differences don't show up in local tests.

import { Server, SignalType } from 'nethernet'
import type { Connection as NethernetConnection, SignalStructure } from 'nethernet'
import type { SignalResponder } from './types/internals.ts'

/** Per-server bookkeeping for connections that haven't been announced yet. */
interface EarlyPackets {
  open: Set<bigint>
  early: Map<bigint, Buffer[]>
}
const state = new WeakMap<Server, EarlyPackets>()
function stateOf (server: Server): EarlyPackets {
  let s = state.get(server)
  if (!s) state.set(server, s = { open: new Set(), early: new Map() })
  return s
}

let installed = false

export function installLanFixes (): void {
  if (installed) return
  installed = true

  // node-nethernet gathers ICE candidates while building its answer, so it sends
  // CANDIDATEADD before CONNECTRESPONSE. A real client can't apply a candidate before it
  // has the answer (libwebrtc rejects it), and the game may treat that as a failed
  // connection. Hold candidates until the answer has gone out.
  const handleOffer = Server.prototype.handleOffer
  Server.prototype.handleOffer = function (this: Server, signal: SignalStructure, respond: SignalResponder, ...rest: unknown[]) {
    let answered = false
    const held: SignalStructure[] = []
    const ordered: SignalResponder = (out) => {
      if (answered) return respond(out)
      if (out.type === SignalType.CandidateAdd) {
        held.push(out)
        return
      }
      respond(out)
      if (out.type === SignalType.ConnectResponse) {
        answered = true
        for (const c of held.splice(0)) respond(c)
      }
    }
    return (handleOffer as (...a: unknown[]) => Promise<void>).call(this, signal, ordered, ...rest)
  }

  // A real client sends its first game packet (request_network_settings) the moment the
  // ReliableDataChannel opens. node-nethernet only announces the connection
  // (openConnection) once the UnreliableDataChannel is open too, a few milliseconds
  // later, so bedrock-protocol drops that first packet as coming from an unknown
  // address. The client then waits for a reply that never comes and times out.
  // Hold packets from not-yet-announced connections and replay them right after.
  const emit = Server.prototype.emit as (this: Server, event: string | symbol, ...args: unknown[]) => boolean
  Server.prototype.emit = function (this: Server, event: string | symbol, ...args: unknown[]): boolean {
    const { open, early } = stateOf(this)
    switch (event) {
      case 'encapsulated': {
        const [data, id] = args as [Buffer, bigint]
        if (!open.has(id) && this.connections?.has(id)) {
          let queue = early.get(id)
          if (!queue) early.set(id, queue = [])
          queue.push(Buffer.from(data))
          return true
        }
        break
      }
      case 'openConnection': {
        const id = (args[0] as NethernetConnection).address
        const result = emit.call(this, event, ...args) // registers the player synchronously
        open.add(id)
        const queued = early.get(id) ?? []
        early.delete(id)
        for (const data of queued) emit.call(this, 'encapsulated', data, id)
        return result
      }
      case 'closeConnection': {
        const id = args[0] as bigint
        open.delete(id)
        early.delete(id)
        break
      }
    }
    return emit.call(this, event, ...args)
  } as typeof Server.prototype.emit
}
