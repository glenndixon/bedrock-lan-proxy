'use strict'
// End-to-end check, all on this machine:
//
//   test client ──NetherNet LAN discovery + WebRTC──▶ LanProxy ──RakNet──▶ fake remote server
//
// Passes when the client discovers the proxy by LAN broadcast, sees the remote's name in
// the advertisement, joins, and packets flow both ways through the relay.

const assert = require('node:assert')
const { Server, createClient } = require('bedrock-protocol')
const { CURRENT_VERSION } = require('bedrock-protocol/src/options')
const { NethernetClient } = require('bedrock-protocol/src/nethernet')
const { LanProxy } = require('../src/proxy')

const UPSTREAM_PORT = 19140
const DISCOVERY_HOST = process.env.DISCOVERY_HOST || '255.255.255.255'
const version = CURRENT_VERSION

function step (msg) { console.log(`  • ${msg}`) }
const timeout = (ms, what) => new Promise((_resolve, reject) => setTimeout(() => reject(new Error(`Timed out: ${what}`)), ms).unref())

async function main () {
  const results = { upstreamGotPacket: false, clientGotPacket: false }

  // 1. Fake remote server (RakNet, offline so no Xbox auth is needed)
  const upstream = new Server({
    host: '127.0.0.1',
    port: UPSTREAM_PORT,
    offline: true,
    version,
    raknetBackend: 'jsp-raknet'
  })
  // bedrock-protocol ignores a string motd option on RakNet servers, so set it directly
  upstream.advertisement.motd = 'Fake Remote'
  upstream.advertisement.levelName = 'Remote World'
  const upstreamSawPacket = new Promise(resolve => {
    upstream.on('connect', player => {
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
  await upstream.listen()
  step(`fake remote listening on 127.0.0.1:${UPSTREAM_PORT}`)

  // 2. The proxy under test
  const proxy = new LanProxy({
    host: '127.0.0.1',
    port: UPSTREAM_PORT,
    offline: true,
    lanOffline: true,
    raknet: 'jsp-raknet'
  })
  proxy.on('info', m => step(`proxy: ${m}`))
  proxy.on('warn', m => step(`proxy warning: ${m}`))
  proxy.on('error', e => step(`proxy error: ${e.message}`))
  await proxy.start()
  assert.strictEqual(proxy.remote.motd, 'Fake Remote', 'proxy should read the remote MOTD')

  // 3. Find the proxy by LAN discovery broadcast on UDP 7551, like a Bedrock client does.
  //    (bedrock-protocol's own ping() insists on raknet-native, so discover directly.)
  const discovery = new NethernetClient({ host: DISCOVERY_HOST })
  const ad = await discovery.ping(5000)
  discovery.close()
  step(`client: discovered "${ad.motd}" / "${ad.levelName}" v${ad.gameVersion} (protocol ${ad.protocol}), ${ad.playerCount}/${ad.playersMax}, NetherNet id ${ad.networkId}`)
  assert.strictEqual(ad.motd, 'Fake Remote', 'LAN advertisement should mirror the remote MOTD')
  assert.strictEqual(ad.levelName, 'Remote World')
  assert.strictEqual(ad.networkId, proxy.networkId)

  // 4. Join it over NetherNet/WebRTC
  const client = createClient({
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

  try {
    await Promise.race([Promise.all([clientSawPacket, upstreamSawPacket]), timeout(30000, 'relay round trip')])
  } finally {
    client.close()
    await proxy.stop()
    await upstream.close()
  }

  assert.ok(results.clientGotPacket && results.upstreamGotPacket)
  console.log('\nPASS: discovery, join and two-way relay all work')
  process.exit(0)
}

main().catch(err => {
  console.error('\nFAIL:', err.message)
  process.exit(1)
})
