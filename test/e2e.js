'use strict'
// End-to-end check, all on this machine, NetherNet on both sides:
//
//   test client ──NetherNet, LAN discovery (UDP 7551)──▶ LanProxy
//   LanProxy ──NetherNet, HTTP signalling──▶ fake remote server
//
// Passes when the client discovers the proxy by LAN broadcast, sees the remote's name,
// joins, packets flow both ways, the offer to the remote carried a signed identity, and
// the remote's server key was remembered (then enforced) by the trust store.

const assert = require('node:assert')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const JWT = require('jsonwebtoken')
const { createClient } = require('bedrock-protocol')
const { CURRENT_VERSION } = require('bedrock-protocol/src/options')
const { NethernetClient } = require('bedrock-protocol/src/nethernet')
const { LanProxy } = require('../src/proxy')
const { Server: NethernetServer, SignalStructure, SignalType } = require('nethernet')
const { getWebRTC } = require('nethernet/src/webrtc')
const { createServerTrust } = require('../src/trust')
const { startFakeRemote } = require('./fakeRemote')

const REMOTE_PORT = 19150
const DISCOVERY_HOST = process.env.DISCOVERY_HOST || '255.255.255.255'
const version = CURRENT_VERSION

function step (msg) { console.log(`  • ${msg}`) }
const timeout = (ms, what) => new Promise((_resolve, reject) => setTimeout(() => reject(new Error(`Timed out: ${what}`)), ms).unref())

function trustStoreChecks (dir) {
  const file = path.join(dir, 'unit-trust.json')
  const logs = []
  const trust = createServerTrust({ file, log: (level, msg) => logs.push(level) })
  const a = 'sha256:' + 'a'.repeat(64)
  const b = 'sha256:' + 'b'.repeat(64)
  assert.strictEqual(trust.onServerKey(a, 'http://x:1'), true, 'first key is trusted')
  assert.strictEqual(trust.onServerKey(a, 'http://x:1'), true, 'same key again is trusted')
  assert.strictEqual(trust.onServerKey(b, 'http://x:1'), false, 'changed key is refused')
  assert.deepStrictEqual(logs, ['info', 'warn'])
  assert.deepStrictEqual(createServerTrust({ file, pinned: b }), { serverKey: b })
  step('trust store: remembers first key, refuses a changed one, honours a pin')
}

// Real clients can't apply a candidate before the answer, so the answer must go first.
async function signalOrderCheck () {
  const { RTCPeerConnection } = getWebRTC('werift')
  const pc = new RTCPeerConnection({ iceServers: [] })
  pc.createDataChannel('ReliableDataChannel')
  pc.createDataChannel('UnreliableDataChannel', { ordered: false, maxRetransmits: 0 })
  await pc.setLocalDescription(await pc.createOffer())
  const server = new NethernetServer()
  const sent = []
  await server.handleOffer(new SignalStructure(SignalType.ConnectRequest, 1n, pc.localDescription.sdp, 2n), s => sent.push(s.type))
  await new Promise(resolve => setTimeout(resolve, 500))
  server.close()
  pc.close()
  assert.strictEqual(sent[0], SignalType.ConnectResponse, `first signal should be the answer, got ${sent.join(', ')}`)
  assert.ok(sent.includes(SignalType.CandidateAdd), 'candidates should still be sent')
  step(`LAN signalling order: ${sent.join(' → ')}`)
}

// Real clients send their first packet when ReliableDataChannel opens, before
// node-nethernet announces the connection. It must be held, not dropped.
function earlyPacketCheck () {
  const server = new NethernetServer()
  const id = 99n
  server.connections.set(id, { close () {} })
  const seen = []
  let registered = false
  server.on('openConnection', () => { registered = true })
  server.on('encapsulated', (data, from) => seen.push({ data: data.toString(), from, registered }))
  server.emit('encapsulated', Buffer.from('request_network_settings'), id)
  assert.strictEqual(seen.length, 0, 'early packet should be held until the connection is announced')
  server.emit('openConnection', { address: id })
  server.emit('encapsulated', Buffer.from('login'), id)
  assert.deepStrictEqual(seen, [
    { data: 'request_network_settings', from: id, registered: true },
    { data: 'login', from: id, registered: true }
  ])
  server.close()
  step('early packets: held until the player is registered, then delivered in order')
}

async function main () {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'blp-test-'))
  if (process.env.BLP_TRACE) require('../src/diagnostics').startDiagnostics(process.env.BLP_TRACE)
  await signalOrderCheck()
  earlyPacketCheck()
  const trustFile = path.join(tmp, 'known_servers.json')
  trustStoreChecks(tmp)

  // 1. Fake remote: NetherNet with HTTP signalling, offline (no Xbox auth)
  // Slow answers give the player time to leave while their upstream is pending.
  const remote = await startFakeRemote({ port: REMOTE_PORT, version, motd: 'Fake Remote', levelName: 'Remote World', answerDelayMs: 1500 })
  step(`fake remote listening at ${remote.url} (server key ${remote.fingerprint.slice(0, 20)}…)`)

  const results = { upstreamGotPacket: false, clientGotPacket: false }
  const upstreamSawPacket = new Promise(resolve => {
    remote.game.on('connect', player => {
      player.on('join', () => {
        if (player.profile.name === 'Banned') {
          player.disconnect('disconnectionScreen.serverFull')
          return
        }
        if (remote.online.has(player.profile.name) && remote.joins.at(-1) !== player.profile.name) return
        step(`remote: ${player.profile.name} joined via proxy; sending set_time`)
        player.queue('set_time', { time: 4242 })
      })
      player.on('set_local_player_as_initialized', () => {
        results.upstreamGotPacket = true
        step('remote: received set_local_player_as_initialized from the LAN client')
        resolve()
      })
    })
  })

  // 2. The proxy under test
  const proxy = new LanProxy({
    host: '127.0.0.1',
    port: REMOTE_PORT,
    offline: true,
    lanOffline: true,
    trustFile,
    profilesFolder: path.join(tmp, 'auth')
  })
  proxy.on('info', m => step(`proxy: ${m}`))
  proxy.on('warn', m => step(`proxy warning: ${m}`))
  proxy.on('debug', m => { if (/cancelled/.test(m)) step(`proxy: ${m}`) })
  proxy.on('error', e => step(`proxy error: ${e.message}`))
  await proxy.start()
  assert.strictEqual(proxy.remote.motd, 'Fake Remote', 'proxy should read the remote name over HTTP')
  assert.strictEqual(proxy.version, version, 'proxy should match the remote version')

  const clients = []
  const join = (username) => {
    const c = createClient({
      transport: 'nethernet',
      nethernet: { networkId: proxy.networkId },
      host: DISCOVERY_HOST,
      skipPing: true,
      offline: true,
      username,
      version
    })
    c.on('error', e => step(`client ${username} error: ${e.message}`))
    clients.push(c)
    return c
  }

  try {
    // 3. Find the proxy by LAN discovery broadcast, like a Bedrock client does.
    //    (bedrock-protocol's own ping() loads RakNet, which isn't installed, so discover directly.)
    const discovery = new NethernetClient({ host: DISCOVERY_HOST })
    const ad = await discovery.ping(5000)
    discovery.close()
    step(`client: discovered "${ad.motd}" / "${ad.levelName}" v${ad.gameVersion}, ${ad.playerCount}/${ad.playersMax}, NetherNet id ${ad.networkId}`)
    assert.strictEqual(ad.motd, 'Fake Remote', 'LAN advertisement should mirror the remote name')
    assert.strictEqual(ad.levelName, 'Remote World')
    assert.strictEqual(ad.networkId, proxy.networkId)

    // 4. Leave while the upstream connection is still pending (like being kicked for
    //    Microsoft sign-in). The proxy must not carry on and log in to the remote anyway.
    const quitter = join('LanTester')
    await new Promise(resolve => quitter.once('join', resolve))
    step('client: logged in to proxy, then left before the remote answered')
    quitter.close()
    await new Promise(resolve => setTimeout(resolve, 2500))
    assert.deepStrictEqual(remote.joins, [], 'nobody should reach the remote after the player left')
    step('remote: no orphaned login after the player left')

    // 5. Join again as the same account: must work (no "logged in from another location")
    const client = join('LanTester')
    const clientSawPacket = new Promise((resolve, reject) => {
      client.on('join', () => step('client: logged in to proxy'))
      client.on('disconnect', p => reject(new Error(`rejoin was kicked: ${p.message}`)))
      client.on('set_time', p => {
        assert.strictEqual(p.time, 4242)
        results.clientGotPacket = true
        step('client: received set_time 4242 from the remote')
        client.queue('set_local_player_as_initialized', { runtime_entity_id: 1n })
        resolve()
      })
    })
    await Promise.race([Promise.all([clientSawPacket, upstreamSawPacket]), timeout(45000, 'relay round trip')])
    assert.deepStrictEqual(remote.joins, ['LanTester'])

    // 5b. Split-screen: a second local player's packets carry sub-client bits in the header.
    //     They must cross the proxy byte for byte, both ways, without upsetting player one.
    const varint = (n) => { const out = []; while (n > 0x7f) { out.push((n & 0x7f) | 0x80); n >>>= 7 } out.push(n); return Buffer.from(out) }
    const toServer = Buffer.concat([varint(93 | (1 << 12)), Buffer.from('second player skin bytes')]) // player_skin, sub-client 1
    const toClient = Buffer.concat([varint(2 | (1 << 12)), Buffer.from([0, 0, 0, 3])]) // play_status, sub-client 1
    const remotePlayer = Object.values(remote.game.clients).find(p => p.profile?.name === 'LanTester')
    const gotOnServer = new Promise(resolve => {
      const read = remotePlayer.readPacket.bind(remotePlayer)
      remotePlayer.readPacket = (packet) => (packet[1] & 0x30) ? resolve(Buffer.from(packet)) : read(packet)
    })
    const gotOnClient = new Promise(resolve => {
      const read = client.readPacket.bind(client)
      client.readPacket = (packet) => (packet[1] & 0x30) ? resolve(Buffer.from(packet)) : read(packet)
    })
    client.sendBuffer(toServer, true)
    assert.deepStrictEqual(await Promise.race([gotOnServer, timeout(10000, 'sub-client packet to server')]), toServer)
    remotePlayer.sendBuffer(toClient, true)
    assert.deepStrictEqual(await Promise.race([gotOnClient, timeout(10000, 'sub-client packet to client')]), toClient)
    assert.ok(remote.online.has('LanTester'), 'player one should still be connected')
    step('split-screen: sub-client packets crossed the proxy unchanged in both directions')

    // 6. A kick from the remote reaches the player with the server's own reason
    const banned = join('Banned')
    const kicked = await Promise.race([
      new Promise(resolve => banned.on('disconnect', p => resolve(p.message))),
      timeout(30000, 'kick passthrough')
    ])
    assert.strictEqual(kicked, 'disconnectionScreen.serverFull')
    step(`client: kicked with the remote's reason (${kicked})`)
  } finally {
    for (const c of clients) c.close()
    await proxy.stop()
    await remote.close()
  }

  assert.ok(results.clientGotPacket && results.upstreamGotPacket)

  // 7. The offers the proxy sent upstream carried a signed identity for the player
  const names = remote.offers.map(({ sdp }) => {
    const identityLine = sdp.split(/\r?\n/).find(l => l.startsWith('a=identity:'))
    assert.ok(identityLine, 'offer should include a=identity')
    const envelope = JSON.parse(Buffer.from(identityLine.slice('a=identity:'.length), 'base64').toString())
    return JWT.decode(JSON.parse(envelope.assertion).token).xname
  })
  assert.ok(names.includes('LanTester'))
  step(`remote: offers carried signed identities for ${[...new Set(names)].join(', ')}`)

  // 8. The remote's key was remembered on first use
  const store = JSON.parse(fs.readFileSync(trustFile, 'utf8'))
  assert.strictEqual(store[remote.url], remote.fingerprint)
  step('proxy: remembered the remote server key')

  fs.rmSync(tmp, { recursive: true, force: true })
  console.log('\nPASS: discovery, join, two-way relay over NetherNet, cancelled upstreams, kick reasons, identity and key trust all work')
  process.exit(0)
}

main().catch(err => {
  console.error('\nFAIL:', err.stack || err.message)
  process.exit(1)
})
