'use strict'

// --debug: write a detailed trace of every connection step to a log file, so a failed
// join can be diagnosed afterwards. Covers LAN signalling in and out, WebRTC/ICE state,
// logins and kicks (via the libraries' own debug output), and the upstream connection.

const fs = require('node:fs')
const util = require('node:util')
const path = require('node:path')
const { Server, Client: NethernetClient, SignalType } = require('nethernet')

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

// werift ships its own copy of the debug module, so configure every copy.
function debugModules () {
  const mods = new Set([require('debug')])
  for (const from of ['werift', 'nethernet', 'bedrock-protocol']) {
    try {
      mods.add(require(require.resolve('debug', { paths: [path.dirname(require.resolve(from))] })))
    } catch {}
  }
  return [...mods]
}

function summarize (s) {
  if (!s) return ''
  if (s.type === SignalType.CandidateAdd) return s.data
  if (s.type === SignalType.ConnectRequest || s.type === SignalType.ConnectResponse) {
    // Keep the lines that matter for ICE/DTLS; full SDPs are long.
    const keep = String(s.data).split(/\r?\n/).filter(l => /^a=(candidate|ice-|setup|fingerprint|group|identity)/.test(l))
    return keep.map(l => l.startsWith('a=identity:') ? 'a=identity:<present>' : l).join(' | ')
  }
  return s.data
}

function startDiagnostics (file) {
  const out = fs.createWriteStream(file, { flags: 'a' })
  const write = (...args) => out.write(`${new Date().toISOString()} ${util.format(...args)}\n`)
  write('==== bedrock-lan-proxy debug session started', process.version, process.platform, process.arch)

  for (const debug of debugModules()) {
    debug.log = (...args) => write(...args)
    if (debug.inspectOpts) debug.inspectOpts.hideDate = true // write() adds the timestamp
    debug.useColors = () => false
    debug.enable(NAMESPACES)
  }

  // LAN signalling, incoming
  const handleMessage = Server.prototype.handleMessage
  Server.prototype.handleMessage = function (packet, rinfo) {
    const data = packet?.params?.data
    if (data && data !== 'Ping') {
      write(`LAN in  from ${rinfo.address}:${rinfo.port} sender=${packet.params.sender_id} recipient=${packet.params.recipient_id}`,
        data.length > 160 ? data.slice(0, 40) + '…' : data)
    }
    return handleMessage.call(this, packet, rinfo)
  }

  // LAN signalling, outgoing, plus WebRTC state for each incoming connection
  const handleOffer = Server.prototype.handleOffer
  Server.prototype.handleOffer = function (signal, respond, ...rest) {
    write(`LAN offer connection=${signal.connectionId} from network id ${signal.networkId}:`, summarize(signal))
    const logged = (s) => {
      write(`LAN out ${s.type} connection=${s.connectionId}:`, summarize(s))
      return respond(s)
    }
    const result = handleOffer.call(this, signal, logged, ...rest)
    const conn = this.connections.get(signal.connectionId)
    if (conn) watchPeer(`downstream ${signal.connectionId}`, conn.rtcConnection, write)
    return result
  }

  // Upstream (proxy → remote) WebRTC state
  const createOffer = NethernetClient.prototype.createOffer
  NethernetClient.prototype.createOffer = function (...args) {
    const result = createOffer.apply(this, args)
    // rtcConnection is created after an await inside createOffer; catch it as soon as it exists.
    const poll = setInterval(() => {
      if (this.rtcConnection || this._closed) {
        clearInterval(poll)
        if (this.rtcConnection) watchPeer('upstream', this.rtcConnection, write)
      }
    }, 5)
    Promise.resolve(result).finally(() => setTimeout(() => clearInterval(poll), 50))
    return result
  }

  process.on('exit', () => write('==== session ended'))
  return { write, file }
}

// Watch a peer connection's state without touching the on* handlers node-nethernet uses.
function watchPeer (label, pc, write) {
  if (!pc || pc.__blpWatched) return
  pc.__blpWatched = true
  const events = [
    ['connectionStateChange', 'connectionstatechange', () => `connection=${pc.connectionState}`],
    ['iceConnectionStateChange', 'iceconnectionstatechange', () => `ice=${pc.iceConnectionState}`],
    ['iceGatheringStateChange', 'icegatheringstatechange', () => `gathering=${pc.iceGatheringState}`]
  ]
  for (const [weriftEvent, domEvent, read] of events) {
    if (pc[weriftEvent]?.subscribe) pc[weriftEvent].subscribe(() => write(`${label} ${read()}`)) // werift
    else pc.addEventListener?.(domEvent, () => write(`${label} ${read()}`)) // native wrtc
  }
  write(`${label} watching: ${events.map(([, , read]) => read()).join(' ')}`)
}

module.exports = { startDiagnostics }
