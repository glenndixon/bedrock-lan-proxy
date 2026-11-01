'use strict'

// bedrock-protocol's Relay, with the upstream connection tied to the LAN player's lifetime.
//
// The stock Relay starts a player's upstream connection when they join and only links
// it to the player once the remote accepts them. If the player leaves first (e.g. they
// were kicked to do the one-time Microsoft sign-in), the upstream connection carries on
// and joins the remote server as them with nobody attached. Their next attempt is then a
// second login for an account that's already online, which the server rejects.
//
// This version cancels the upstream connection when the player leaves, passes the
// remote server's own disconnect reason through to the player instead of a generic one,
// and relays split-screen (sub-client) packets untouched.

const { Relay, Client } = require('bedrock-protocol')
const debug = require('debug')('minecraft-protocol')

// Split-screen players are "sub-clients": they share the first player's connection, and
// each packet header carries which sub-client it's from or for (bits 10-13 of the packet
// ID varint). bedrock-protocol doesn't decode those bits, so it would mangle the packet
// (e.g. send the server a player_skin with no body, which gets the whole connection
// dropped). NetherNet has no game-layer encryption, so pass these packets through
// byte for byte instead; the server sees exactly what the console sent.
function subClientBits (packet) {
  let value = 0
  let shift = 0
  for (let i = 0; i < packet.length && i < 5; i++) {
    value |= (packet[i] & 0x7f) << shift
    if (!(packet[i] & 0x80)) break
    shift += 7
  }
  return (value >> 10) & 0xf
}

function withSubClientPassthrough (Base) {
  return class SubClientRelayPlayer extends Base {
    // Console → proxy → remote
    readPacket (packet) {
      if (this.startRelaying && subClientBits(packet)) {
        this.downInLog('Relaying sub-client packet raw', packet.length, 'bytes')
        if (this.upstream) this.upstream.sendBuffer(packet)
        else this.upQ.push(packet)
        return
      }
      return super.readPacket(packet)
    }

    flushUpQueue () {
      const queued = this.upQ
      this.upQ = []
      for (const packet of queued) {
        if (subClientBits(packet)) {
          this.upstream.sendBuffer(packet)
          continue
        }
        const des = this.server.deserializer.parsePacketBuffer(packet)
        if (des.data.name === 'client_cache_status') continue // forced off for relaying
        this.upstream.write(des.data.name, des.data.params)
      }
    }

    // Remote → proxy → console
    readUpstream (packet) {
      if (subClientBits(packet)) {
        this.upInLog('Relaying sub-client packet raw', packet.length, 'bytes')
        if (this.startRelaying) this.sendBuffer(packet)
        else this.downQ.push(packet)
        return
      }
      return super.readUpstream(packet)
    }

    flushDownQueue () {
      const queued = this.downQ
      this.downQ = []
      for (const packet of queued) {
        if (subClientBits(packet)) {
          this.sendBuffer(packet)
          continue
        }
        const des = this.server.deserializer.parsePacketBuffer(packet)
        this.write(des.data.name, des.data.params)
      }
    }
  }
}

class ProxyRelay extends Relay {
  constructor (options) {
    super(options)
    this.RelayPlayer = withSubClientPassthrough(this.RelayPlayer)
  }

  async openUpstreamConnection (ds, clientAddr) {
    const key = String(clientAddr)
    const options = {
      authTitle: this.options.authTitle,
      flow: this.options.flow,
      deviceType: this.options.deviceType,
      offline: this.options.destination.offline ?? this.options.offline,
      username: this.options.offline ? ds.profile.name : ds.profile.xuid,
      version: this.options.version,
      host: this.options.destination.host,
      port: this.options.destination.port,
      transport: this.options.destination.transport,
      nethernet: this.options.destination.nethernet,
      batchingInterval: this.options.batchingInterval,
      onMsaCode: (code) => {
        if (this.options.onMsaCode) this.options.onMsaCode(code, ds)
        else ds.disconnect('Sign in at ' + code.verification_uri + ' with code ' + code.user_code)
      },
      profilesFolder: this.options.profilesFolder,
      autoInitPlayer: false
    }

    // If the player is already gone (left during the join handshake), don't start.
    if (ds._closed) return

    const client = new Client(options)
    if (!client.noLoginForward) client.options.skinData = ds.skinData
    client.outLog = ds.upOutLog
    client.inLog = ds.upInLog

    let kick = null
    let finished = false
    const finish = () => {
      finished = true
      ds.off('close', onPlayerClose)
      if (this.upstreams.get(key) === client) this.upstreams.delete(key)
    }

    // Player left before (or after) the remote accepted them: cancel the upstream.
    // Microsoft sign-in still completes and caches its token if it's in progress.
    const onPlayerClose = () => {
      if (finished) return
      finish()
      this.emit('upstreamCancelled', ds, client)
      client.close()
    }
    ds.once('close', onPlayerClose)

    client.on('kick', (packet) => {
      kick = packet
      this.emit('upstreamKick', ds, packet)
    })

    client.once('join', () => {
      if (finished) return client.close()
      client.write('client_cache_status', { enabled: this.enableChunkCaching })
      ds.upstream = client
      ds.flushUpQueue()
      this.conLog('Connected to upstream server')
      client.readPacket = (packet) => ds.readUpstream(packet)
      this.emit('join', ds, client)
    })

    client.on('error', (err) => {
      if (finished) return
      finish()
      debug(clientAddr, 'was disconnected because of error', err)
      ds.disconnect('Could not reach the server: ' + err.message)
    })

    client.on('close', () => {
      if (finished) return
      finish()
      // Pass the server's own message through; the game translates keys like
      // disconnectionScreen.loggedinOtherLocation into readable text.
      ds.disconnect(kick?.message || 'The server closed the connection')
    })

    this.upstreams.set(key, client)
    client.connect()
  }

  closeUpstreamConnection (clientAddr) {
    const key = String(clientAddr)
    this.upstreams.get(key)?.close()
    this.upstreams.delete(key)
  }
}

module.exports = { ProxyRelay }
