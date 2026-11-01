'use strict'
// A stand-in for a Bedrock 1.26.60+ dedicated server, for tests: NetherNet with HTTP
// signalling on its game port.
//
//   GET  /v1/join        → JSON metadata (name, level, version, players…)
//   POST /v1/join/<id>   → client's signed WebRTC offer in, server's signed answer out
//
// Game traffic then runs over WebRTC to a bedrock-protocol server.

const http = require('node:http')
const crypto = require('node:crypto')
const { once } = require('node:events')
const JWT = require('jsonwebtoken')
const { Server: BedrockServer } = require('bedrock-protocol')
const { NethernetServer } = require('bedrock-protocol/src/nethernet')
const { Versions } = require('bedrock-protocol/src/options')
const { SignalStructure, SignalType } = require('nethernet')
const { attachIdentity } = require('nethernet/src/signalling/sdpIdentity')

async function startFakeRemote ({ host = '127.0.0.1', port, version, motd, levelName, answerDelayMs = 0 }) {
  // Game server on NetherNet. Skip listen(): it would bind LAN discovery on UDP 7551,
  // which the proxy under test needs. Wire the transport up by hand instead.
  const game = new BedrockServer({ transport: 'nethernet', offline: true, version })
  game.transport = new NethernetServer({ maxPlayers: 10 }, game)
  game.transport.onOpenConnection = game.onOpenConnection
  game.transport.onCloseConnection = game.onCloseConnection
  game.transport.onEncapsulated = game.onEncapsulated
  const nethernet = game.transport.nethernet

  // Like a real server: an account can only be online once. A second login is refused.
  const online = new Set()
  const joins = [] // names that joined, for assertions
  game.on('connect', player => {
    player.once('join', () => {
      const name = player.profile.name
      if (online.has(name)) {
        player.disconnect('disconnectionScreen.loggedinOtherLocation')
        return
      }
      online.add(name)
      joins.push(name)
      player.once('close', () => online.delete(name))
    })
  })

  // The operator key the answer is signed with; clients pin its fingerprint.
  const operator = crypto.generateKeyPairSync('ec', { namedCurve: 'secp384r1' })
  const jwk = operator.publicKey.export({ format: 'jwk' })
  const operatorToken = JWT.sign({ cpk: jwk }, operator.privateKey, { algorithm: 'ES384', expiresIn: 3600 })
  const fingerprint = 'sha256:' + crypto.createHash('sha256')
    .update(operator.publicKey.export({ type: 'spki', format: 'der' })).digest('hex')

  const offers = [] // offers received, for assertions

  const server = http.createServer(async (req, res) => {
    try {
      if (req.method === 'GET' && req.url === '/v1/join') {
        res.setHeader('content-type', 'application/json')
        res.end(JSON.stringify({
          name: motd,
          level: levelName,
          protocol: Versions[version],
          version,
          players: game.clientCount,
          maxPlayers: 10,
          gameType: 'Survival'
        }))
        return
      }
      const m = req.url.match(/^\/v1\/join\/(\d+)$/)
      if (req.method !== 'POST' || !m) { res.statusCode = 404; res.end(); return }

      let offer = ''
      for await (const chunk of req) offer += chunk
      offers.push({ clientNetworkId: m[1], sdp: offer })
      // Simulate a slow path to the server (e.g. a player still signing in to Microsoft).
      if (answerDelayMs) await new Promise(resolve => setTimeout(resolve, answerDelayMs))
      if (req.socket.destroyed) return // client gave up

      const connectionId = crypto.randomBytes(8).readBigUInt64BE()
      const signal = new SignalStructure(SignalType.ConnectRequest, connectionId, offer, BigInt(m[1]))
      await new Promise((resolve, reject) => {
        nethernet.handleOffer(signal, reply => {
          if (reply.type === SignalType.ConnectResponse) resolve()
          else if (reply.type === SignalType.ConnectError) reject(new Error(`connect error ${reply.data}`))
        })
      })
      // HTTP signalling has no trickle: wait for every candidate, then sign the answer.
      const rtc = nethernet.connections.get(connectionId).rtcConnection
      while (rtc.iceGatheringState !== 'complete') await once(rtc, 'icegatheringstatechange')
      const answer = attachIdentity(rtc.localDescription.sdp, { privateKey: operator.privateKey, token: operatorToken })
      res.setHeader('content-type', 'application/sdp')
      res.end(answer)
    } catch (err) {
      res.statusCode = 500
      res.end(String(err.message))
    }
  })
  server.listen(port, host)
  await once(server, 'listening')

  return {
    game,
    fingerprint,
    offers,
    joins,
    online,
    url: `http://${host}:${port}`,
    async close () {
      server.closeAllConnections()
      await new Promise(resolve => server.close(resolve))
      await game.close()
    }
  }
}

module.exports = { startFakeRemote }
