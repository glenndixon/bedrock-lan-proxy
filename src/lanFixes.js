'use strict'

// Adjustments so real Minecraft clients (Xbox, Switch, phones...) can join over LAN
// signalling. node-nethernet's own client is more forgiving than the real game, so
// these differences don't show up in local tests.

const { Server, SignalType } = require('nethernet')

let installed = false

function installLanFixes () {
  if (installed) return
  installed = true

  // node-nethernet gathers ICE candidates while building its answer, so it sends
  // CANDIDATEADD before CONNECTRESPONSE. A real client can't apply a candidate before it
  // has the answer (libwebrtc rejects it), and the game may treat that as a failed
  // connection. Hold candidates until the answer has gone out.
  const handleOffer = Server.prototype.handleOffer
  Server.prototype.handleOffer = function (signal, respond, ...rest) {
    let answered = false
    const held = []
    const ordered = (out) => {
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
    return handleOffer.call(this, signal, ordered, ...rest)
  }

  // A real client sends its first game packet (request_network_settings) the moment the
  // ReliableDataChannel opens. node-nethernet only announces the connection
  // (openConnection) once the UnreliableDataChannel is open too, a few milliseconds
  // later, so bedrock-protocol drops that first packet as coming from an unknown
  // address. The client then waits for a reply that never comes and times out.
  // Hold packets from not-yet-announced connections and replay them right after.
  const emit = Server.prototype.emit
  Server.prototype.emit = function (event, ...args) {
    this._blpOpen ??= new Set()
    this._blpEarly ??= new Map()
    switch (event) {
      case 'encapsulated': {
        const [data, id] = args
        if (!this._blpOpen.has(id) && this.connections?.has(id)) {
          if (!this._blpEarly.has(id)) this._blpEarly.set(id, [])
          this._blpEarly.get(id).push(Buffer.from(data))
          return true
        }
        break
      }
      case 'openConnection': {
        const id = args[0].address
        const result = emit.call(this, event, ...args) // registers the player synchronously
        this._blpOpen.add(id)
        const early = this._blpEarly.get(id) || []
        this._blpEarly.delete(id)
        for (const data of early) emit.call(this, 'encapsulated', data, id)
        return result
      }
      case 'closeConnection':
        this._blpOpen.delete(args[0])
        this._blpEarly.delete(args[0])
        break
    }
    return emit.call(this, event, ...args)
  }
}

module.exports = { installLanFixes }
