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

async function main () {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'blp-test-'))
  const trustFile = path.join(tmp, 'known_servers.json')
  trustStoreChecks(tmp)

  // 1. Fake remote: NetherNet with HTTP signalling, offline (no Xbox auth)
  const remote = await startFakeRemote({ port: REMOTE_PORT, version, motd: 'Fake Remote', levelName: 'Remote World' })
  step(`fake remote listening at ${remote.url} (server key ${remote.fingerprint.slice(0, 20)}…)`)

  const results = { upstreamGotPacket: false, clientGotPacket: false }
  const upstreamSawPacket = new Promise(resolve => {
    remote.game.on('connect', player => {
      player.on('join', () => {
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
  proxy.on('error', e => step(`proxy error: ${e.message}`))
  await proxy.start()
  assert.strictEqual(proxy.remote.motd, 'Fake Remote', 'proxy should read the remote name over HTTP')
  assert.strictEqual(proxy.version, version, 'proxy should match the remote version')

  let client
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

    // 4. Join it
    client = createClient({
      transport: 'nethernet',
      nethernet: { networkId: ad.networkId },
      host: DISCOVERY_HOST,
      skipPing: true,
      offline: true,
      username: 'LanTester',
      version
    })
    client.conLog = m => step(`client: ${m}`)
    client.on('error', e => step(`client error: ${e.message}`))

    const clientSawPacket = new Promise(resolve => {
      client.on('join', () => step('client: logged in to proxy'))
      client.on('set_time', p => {
        assert.strictEqual(p.time, 4242)
        results.clientGotPacket = true
        step('client: received set_time 4242 from the remote')
        client.queue('set_local_player_as_initialized', { runtime_entity_id: 1n })
        resolve()
      })
    })

    await Promise.race([Promise.all([clientSawPacket, upstreamSawPacket]), timeout(45000, 'relay round trip')])
  } finally {
    client?.close()
    await proxy.stop()
    await remote.close()
  }

  assert.ok(results.clientGotPacket && results.upstreamGotPacket)

  // 5. The offer the proxy sent upstream carried a signed identity for the player
  assert.strictEqual(remote.offers.length, 1)
  const identityLine = remote.offers[0].sdp.split(/\r?\n/).find(l => l.startsWith('a=identity:'))
  assert.ok(identityLine, 'offer should include a=identity')
  const envelope = JSON.parse(Buffer.from(identityLine.slice('a=identity:'.length), 'base64').toString())
  const claims = JWT.decode(JSON.parse(envelope.assertion).token)
  assert.strictEqual(claims.xname, 'LanTester')
  step(`remote: offer carried a signed identity for ${claims.xname}`)

  // 6. The remote's key was remembered on first use
  const store = JSON.parse(fs.readFileSync(trustFile, 'utf8'))
  assert.strictEqual(store[remote.url], remote.fingerprint)
  step('proxy: remembered the remote server key')

  fs.rmSync(tmp, { recursive: true, force: true })
  console.log('\nPASS: discovery, join, two-way relay over NetherNet, identity and key trust all work')
  process.exit(0)
}

main().catch(err => {
  console.error('\nFAIL:', err.stack || err.message)
  process.exit(1)
})
