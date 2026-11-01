// End-to-end check, all on this machine, NetherNet on both sides:
//
//   test client ──NetherNet, LAN discovery (UDP 7551)──▶ LanProxy
//   LanProxy ──NetherNet, HTTP signalling──▶ fake remote server
//
// Passes when the client discovers the proxy by LAN broadcast, sees the remote's name,
// joins, packets flow both ways, the offer to the remote carried a signed identity, and
// the remote's server key was remembered (then enforced) by the trust store.

import assert from 'node:assert'
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import JWT from 'jsonwebtoken'
import { createClient } from 'bedrock-protocol'
import type { Client } from 'bedrock-protocol'
import { CURRENT_VERSION } from 'bedrock-protocol/src/options.js'
import { NethernetClient } from 'bedrock-protocol/src/nethernet/index.js'
import { Server as NethernetServer, SignalStructure, SignalType } from 'nethernet'
import type { Connection as NethernetConnection } from 'nethernet'
import { getWebRTC } from 'nethernet/src/webrtc.js'
import { LanProxy, signInMessage } from '../src/proxy.ts'
import { createServerTrust } from '../src/trust.ts'
import { writeVarint as varint } from '../src/relay.ts'
import type { DisconnectParams } from '../src/types/internals.ts'
import { startFakeRemote } from './fakeRemote.ts'
import type { TestPlayer } from './fakeRemote.ts'

const REMOTE_PORT = 19150
const DISCOVERY_HOST = process.env.DISCOVERY_HOST || '255.255.255.255'
const version = CURRENT_VERSION

/** A test client, with the connection internals the split-screen checks reach into. */
type TestClient = Client & { readPacket (packet: Buffer): void }

function step (msg: string): void { console.log(`  • ${msg}`) }
const timeout = (ms: number, what: string): Promise<never> =>
  new Promise((_resolve, reject) => setTimeout(() => reject(new Error(`Timed out: ${what}`)), ms).unref())
const sleep = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms))

function trustStoreChecks (dir: string): void {
  const file = path.join(dir, 'unit-trust.json')
  const logs: string[] = []
  const trust = createServerTrust({ file, log: (level) => logs.push(level) })
  const a = 'sha256:' + 'a'.repeat(64)
  const b = 'sha256:' + 'b'.repeat(64)
  assert.ok(trust.onServerKey)
  assert.strictEqual(trust.onServerKey(a, 'http://x:1'), true, 'first key is trusted')
  assert.strictEqual(trust.onServerKey(a, 'http://x:1'), true, 'same key again is trusted')
  assert.strictEqual(trust.onServerKey(b, 'http://x:1'), false, 'changed key is refused')
  assert.deepStrictEqual(logs, ['info', 'warn'])
  assert.deepStrictEqual(createServerTrust({ file, pinned: b }), { serverKey: b })
  step('trust store: remembers first key, refuses a changed one, honours a pin')
}

// Real clients can't apply a candidate before the answer, so the answer must go first.
async function signalOrderCheck (): Promise<void> {
  const { RTCPeerConnection } = getWebRTC('werift')
  const pc = new RTCPeerConnection({ iceServers: [] })
  pc.createDataChannel('ReliableDataChannel')
  pc.createDataChannel('UnreliableDataChannel', { ordered: false, maxRetransmits: 0 })
  await pc.setLocalDescription(await pc.createOffer())
  const server = new NethernetServer()
  const sent: string[] = []
  await server.handleOffer(new SignalStructure(SignalType.ConnectRequest, 1n, pc.localDescription?.sdp ?? '', 2n), s => sent.push(s.type))
  await sleep(500)
  server.close()
  await pc.close()
  assert.strictEqual(sent[0], SignalType.ConnectResponse, `first signal should be the answer, got ${sent.join(', ')}`)
  assert.ok(sent.includes(SignalType.CandidateAdd), 'candidates should still be sent')
  step(`LAN signalling order: ${sent.join(' → ')}`)
}

// Real clients send their first packet when ReliableDataChannel opens, before
// node-nethernet announces the connection. It must be held, not dropped.
function earlyPacketCheck (): void {
  const server = new NethernetServer()
  const id = 99n
  server.connections.set(id, { close () {} } as unknown as NethernetConnection)
  const seen: Array<{ data: string, from: bigint, registered: boolean }> = []
  let registered = false
  server.on('openConnection', () => { registered = true })
  server.on('encapsulated', (data, from) => seen.push({ data: data.toString(), from, registered }))
  server.emit('encapsulated', Buffer.from('request_network_settings'), id)
  assert.strictEqual(seen.length, 0, 'early packet should be held until the connection is announced')
  server.emit('openConnection', { address: id } as unknown as NethernetConnection)
  server.emit('encapsulated', Buffer.from('login'), id)
  assert.deepStrictEqual(seen, [
    { data: 'request_network_settings', from: id, registered: true },
    { data: 'login', from: id, registered: true }
  ])
  server.close()
  step('early packets: held until the player is registered, then delivered in order')
}

// The sign-in kick message is shown on the console's disconnect screen, which displays
// formatting codes (§l, §r…) literally, so it must be plain text.
function signInMessageCheck (): void {
  const message = signInMessage('play.example.net', { user_code: 'W5S53QNN', verification_uri: 'https://www.microsoft.com/link' })
  assert.ok(!message.includes('§'), 'sign-in message should have no formatting codes')
  assert.match(message, /https:\/\/www\.microsoft\.com\/link/)
  assert.match(message, /^W5S53QNN$/m, 'the code should be on a line of its own')
  step('sign-in message: plain text, code on its own line')
}

async function main (): Promise<void> {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'blp-test-'))
  if (process.env.BLP_TRACE) (await import('../src/diagnostics.ts')).startDiagnostics(process.env.BLP_TRACE)
  signInMessageCheck()
  await signalOrderCheck()
  earlyPacketCheck()
  const trustFile = path.join(tmp, 'known_servers.json')
  trustStoreChecks(tmp)

  // 1. Fake remote: NetherNet with HTTP signalling, offline (no Xbox auth)
  // Slow answers give the player time to leave while their upstream is pending.
  const remote = await startFakeRemote({ port: REMOTE_PORT, version, motd: 'Fake Remote', levelName: 'Remote World', answerDelayMs: 1500 })
  step(`fake remote listening at ${remote.url} (server key ${remote.fingerprint.slice(0, 20)}…)`)

  const results = { upstreamGotPacket: false, clientGotPacket: false }
  const upstreamSawPacket = new Promise<void>(resolve => {
    remote.game.on('connect', (player) => {
      const p = player as TestPlayer
      p.on('join', () => {
        if (p.profile.name === 'Banned') {
          p.disconnect('disconnectionScreen.serverFull')
          return
        }
        if (remote.online.has(p.profile.name) && remote.joins.at(-1) !== p.profile.name) return
        step(`remote: ${p.profile.name} joined via proxy; sending set_time`)
        p.queue('set_time', { time: 4242 })
      })
      p.on('set_local_player_as_initialized' as 'packet', () => {
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
  assert.strictEqual(proxy.remote?.motd, 'Fake Remote', 'proxy should read the remote name over HTTP')
  assert.strictEqual(proxy.version, version, 'proxy should match the remote version')

  const clients: TestClient[] = []
  const join = (username: string): TestClient => {
    const c = createClient({
      transport: 'nethernet',
      nethernet: { networkId: proxy.networkId },
      host: DISCOVERY_HOST,
      skipPing: true,
      offline: true,
      username,
      version
    }) as TestClient
    c.on('error', (e: Error) => step(`client ${username} error: ${e.message}`))
    clients.push(c)
    return c
  }
  const onPacket = <T>(c: TestClient, name: string, fn: (params: T) => void): void => {
    c.on(name, fn as (...args: unknown[]) => void)
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
    await sleep(2500)
    assert.deepStrictEqual(remote.joins, [], 'nobody should reach the remote after the player left')
    step('remote: no orphaned login after the player left')

    // 5. Join again as the same account: must work (no "logged in from another location")
    const client = join('LanTester')
    const clientSawPacket = new Promise<void>((resolve, reject) => {
      client.on('join', () => step('client: logged in to proxy'))
      onPacket<DisconnectParams>(client, 'disconnect', p => reject(new Error(`rejoin was kicked: ${p.message}`)))
      onPacket<{ time: number }>(client, 'set_time', p => {
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
    const toServer = Buffer.concat([varint(93 | (1 << 12)), Buffer.from('second player skin bytes')]) // player_skin, sub-client 1
    const toClient = Buffer.concat([varint(2 | (1 << 12)), Buffer.from([0, 0, 0, 3])]) // play_status, sub-client 1
    const remotePlayer = Object.values(remote.game.clients).find(p => p.profile?.name === 'LanTester')
    assert.ok(remotePlayer, 'player one should be on the remote')
    const isSub = (packet: Buffer): boolean => ((packet[1] ?? 0) & 0x30) !== 0 // sub-client bits, for 2-byte headers
    const onServer: Buffer[] = []
    const onClient: Buffer[] = []
    const waitFor = (list: Buffer[], n: number, what: string): Promise<void> => Promise.race([
      new Promise<void>(resolve => { const t = setInterval(() => { if (list.length >= n) { clearInterval(t); resolve() } }, 20) }),
      timeout(20000, what)
    ])
    const readServer = remotePlayer.readPacket.bind(remotePlayer)
    remotePlayer.readPacket = (packet) => { isSub(packet) ? onServer.push(Buffer.from(packet)) : readServer(packet) }
    const readClient = client.readPacket.bind(client)
    client.readPacket = (packet) => { isSub(packet) ? onClient.push(Buffer.from(packet)) : readClient(packet) }

    client.sendBuffer(toServer, true)
    await waitFor(onServer, 1, 'sub-client packet to server')
    assert.deepStrictEqual(onServer[0], toServer)
    remotePlayer.sendBuffer(toClient, true)
    await waitFor(onClient, 1, 'sub-client packet to client')
    assert.deepStrictEqual(onClient[0], toClient)

    // A burst bigger than one NetherNet message can hold (~2.5 MB): random bytes so
    // compression can't shrink it. All of it must arrive intact.
    const burst = Array.from({ length: 7 }, () => Buffer.concat([varint(11 | (1 << 12)), crypto.randomBytes(500_000)]))
    for (const packet of burst) remotePlayer.sendBuffer(packet)
    await waitFor(onClient, 1 + burst.length, 'large sub-client burst')
    assert.ok(onClient.slice(1).every((packet, i) => packet.equals(burst[i]!)), 'burst should arrive intact and in order')
    step(`split-screen: a ${(burst.reduce((n, b) => n + b.length, 0) / 1e6).toFixed(1)} MB burst arrived intact`)

    // The server kicking the split-screen player: reason decoded for the log, packet relayed raw.
    const kickReason = new Promise<string>(resolve => proxy.once('warn', resolve))
    const disconnectBody = remote.game.serializer.createPacketBuffer({
      name: 'disconnect',
      params: { reason: 'kicked', hide_disconnect_reason: false, message: 'disconnectionScreen.notAllowed', filtered_message: '' }
    }).subarray(1)
    const subKick = Buffer.concat([varint(5 | (1 << 12)), disconnectBody])
    remotePlayer.sendBuffer(subKick, true)
    const warned = await Promise.race([kickReason, timeout(10000, 'sub-client kick reason')])
    assert.match(warned, /split-screen player 1 .*disconnectionScreen\.notAllowed/)
    await waitFor(onClient, 2 + burst.length, 'sub-client kick to client')
    assert.ok(onClient.at(-1)?.equals(subKick))
    step('split-screen: a kick for the second player was reported and passed through')
    assert.ok(remote.online.has('LanTester'), 'player one should still be connected')
    step('split-screen: sub-client packets crossed the proxy unchanged in both directions')

    // 6. A kick from the remote reaches the player with the server's own reason
    const banned = join('Banned')
    const kicked = await Promise.race([
      new Promise<string | undefined>(resolve => onPacket<DisconnectParams>(banned, 'disconnect', p => resolve(p.message))),
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
    const envelope = JSON.parse(Buffer.from(identityLine.slice('a=identity:'.length), 'base64').toString()) as { assertion: string }
    const { token } = JSON.parse(envelope.assertion) as { token: string }
    return (JWT.decode(token) as { xname?: string } | null)?.xname
  })
  assert.ok(names.includes('LanTester'))
  step(`remote: offers carried signed identities for ${[...new Set(names)].join(', ')}`)

  // 8. The remote's key was remembered on first use
  const store = JSON.parse(fs.readFileSync(trustFile, 'utf8')) as Record<string, string>
  assert.strictEqual(store[remote.url], remote.fingerprint)
  step('proxy: remembered the remote server key')

  fs.rmSync(tmp, { recursive: true, force: true })
  console.log('\nPASS: discovery, join, two-way relay over NetherNet, cancelled upstreams, kick reasons, identity and key trust all work')
  process.exit(0)
}

main().catch((err: unknown) => {
  console.error('\nFAIL:', (err as Error).stack || err)
  process.exit(1)
})
