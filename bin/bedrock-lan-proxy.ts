#!/usr/bin/env node
import { parseArgs } from 'node:util'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { Diagnostics } from '../src/diagnostics.ts'
import type { WebRTCBackend } from '../src/proxy.ts'

const [major = 0] = process.versions.node.split('.').map(Number)
if (major < 24) {
  console.error(`bedrock-lan-proxy needs Node.js 24 or newer (node-nethernet requires it). You have ${process.version}.`)
  process.exit(1)
}

// Loaded after the version check, so older Node versions get the message above.
const { LanProxy, supportedVersions, DEFAULT_PROFILES, DEFAULT_TRUST_FILE } = await import('../src/proxy.ts')

/** Find this package's version, whether running from source (bin/) or the build (dist/bin/). */
function packageVersion (): string {
  let dir = import.meta.dirname
  for (let i = 0; i < 4; i++) {
    const file = path.join(dir, 'package.json')
    if (fs.existsSync(file)) {
      const pkg = JSON.parse(fs.readFileSync(file, 'utf8')) as { name?: string, version?: string }
      if (pkg.name === 'bedrock-lan-proxy' && pkg.version) return pkg.version
    }
    dir = path.dirname(dir)
  }
  return 'unknown'
}
const VERSION = packageVersion()

const HELP = `
bedrock-lan-proxy ${VERSION}
Make a remote Minecraft Bedrock server appear in the Friends tab as a LAN game.
Speaks NetherNet to both your LAN clients and the remote (Bedrock 1.26.60+).

Usage:
  bedrock-lan-proxy <host>[:port] [options]
  bedrock-lan-proxy https://host[:port] [options]

Options:
  -p, --port <n>           Remote game port (default 19132)
  -n, --name <text>        Name shown in the LAN list (default: the remote's name)
  -l, --level <text>       World name shown under it (default: the remote's level name)
  -g, --game-version <v>   Game version to speak, e.g. 1.26.60 (default: match the remote)
      --offline            Join the remote without Xbox sign-in (remote must have online-mode off)
      --server-key <key>   Require this remote server key (sha256:...). Without it, the key
                           seen on first connect is remembered in
                           ${DEFAULT_TRUST_FILE}
  -b, --bind <ip>          Local IPv4 address for LAN discovery (default: all interfaces)
  -m, --max-players <n>    Max players through the proxy at once (default 10)
      --profiles <dir>     Where upstream sign-in tokens are cached
                           (default ${DEFAULT_PROFILES})
      --webrtc <backend>   werift (default), wrtc, or auto
      --debug              Write a detailed connection trace to a log file
      --log-file <path>    Where --debug writes (default ./bedrock-lan-proxy.log)
      --log-packets        Print every relayed packet (very noisy)
      --list-versions      Print supported game versions and exit
  -h, --help               Show this help
      --version            Show the tool version

Examples:
  bedrock-lan-proxy play.example.net
  bedrock-lan-proxy 203.0.113.7:19133 --name "Glenn's Server"
  bedrock-lan-proxy mc.local --offline -b 192.168.1.20
`

function fail (msg: string): never {
  console.error(`error: ${msg}\nRun with --help for usage.`)
  process.exit(2)
}

function parse () {
  try {
    return parseArgs({
      allowPositionals: true,
      options: {
        port: { type: 'string', short: 'p' },
        name: { type: 'string', short: 'n' },
        level: { type: 'string', short: 'l' },
        'game-version': { type: 'string', short: 'g' },
        offline: { type: 'boolean' },
        bind: { type: 'string', short: 'b' },
        'max-players': { type: 'string', short: 'm' },
        profiles: { type: 'string' },
        webrtc: { type: 'string' },
        'server-key': { type: 'string' },
        debug: { type: 'boolean' },
        'log-file': { type: 'string' },
        'log-packets': { type: 'boolean' },
        'list-versions': { type: 'boolean' },
        help: { type: 'boolean', short: 'h' },
        version: { type: 'boolean' }
      }
    })
  } catch (err) {
    return fail((err as Error).message)
  }
}

const { values: v, positionals } = parse()

if (v.help) { console.log(HELP); process.exit(0) }
if (v.version) { console.log(VERSION); process.exit(0) }
if (v['list-versions']) { console.log(supportedVersions().join('\n')); process.exit(0) }

if (positionals.length !== 1) fail('give exactly one remote server, like play.example.net or 1.2.3.4:19132')

// Accept host, host:port, [ipv6]:port, or an http(s):// URL
let host = positionals[0]!
let port = 19132
if (/^https?:\/\//i.test(host)) {
  try { host = new URL(host).origin } catch { fail(`invalid URL ${host}`) }
  if (v.port) fail('put the port in the URL instead of using --port')
} else {
  const m = host.match(/^\[(.+)\](?::(\d+))?$/) || host.match(/^([^:]+)(?::(\d+))?$/)
  if (m?.[1]) {
    host = m[1]
    if (m[2]) port = Number(m[2])
  }
  if (v.port) port = Number(v.port)
  if (!Number.isInteger(port) || port < 1 || port > 65535) fail(`invalid port ${v.port ?? port}`)
}

const maxPlayers = v['max-players'] ? Number(v['max-players']) : undefined
if (maxPlayers !== undefined && (!Number.isInteger(maxPlayers) || maxPlayers < 1)) fail('--max-players must be a positive whole number')

const backends: readonly WebRTCBackend[] = ['werift', 'wrtc', 'auto']
const webrtc = v.webrtc as WebRTCBackend | undefined
if (webrtc && !backends.includes(webrtc)) fail('--webrtc must be werift, wrtc or auto')
if (v['server-key'] && !/^sha256:[0-9a-f]{64}$/.test(v['server-key'])) fail('--server-key must look like sha256:<64 lowercase hex digits>')

const stamp = (): string => new Date().toLocaleTimeString()
let trace: Diagnostics | null = null
if (v.debug) {
  const { startDiagnostics } = await import('../src/diagnostics.ts')
  const diagnostics = startDiagnostics(path.resolve(v['log-file'] || 'bedrock-lan-proxy.log'))
  trace = diagnostics
  diagnostics.write('args:', JSON.stringify(process.argv.slice(2)))
  // --log-packets prints through console.debug; keep a copy in the trace too.
  const consoleDebug = console.debug
  console.debug = (...a: unknown[]) => { consoleDebug(...a); diagnostics.write(...a) }
}
const log = (...a: unknown[]): void => {
  console.log(`[${stamp()}]`, ...a)
  trace?.write(...a)
}

const proxy = new LanProxy({
  host,
  port,
  name: v.name,
  levelName: v.level,
  version: v['game-version'],
  offline: v.offline,
  bind: v.bind,
  maxPlayers,
  profilesFolder: v.profiles,
  webrtc,
  serverKey: v['server-key'],
  logPackets: v['log-packets']
})

proxy.on('info', msg => log(msg))
proxy.on('warn', msg => log('warning:', msg))
if (trace) proxy.on('debug', msg => trace?.write(msg))
proxy.on('remote', r => log(r.motd
  ? `Remote ${proxy.origin} → "${r.motd}" v${r.version ?? '?'}, ${r.playersOnline}/${r.playersMax} online`
  : `Remote ${proxy.origin} is reachable but publishes no name or version`))
proxy.on('auth', ({ player, url, code }) => {
  log(`${player} needs a one-time Microsoft sign-in for the remote server:`)
  log(`    open ${url} and enter ${code}`)
  log('    (they were shown the same code in-game; they can reconnect once signed in)')
})
proxy.on('error', err => log('error:', err.message || err))
proxy.on('listening', ({ networkId, version }) => {
  const ips = Object.values(os.networkInterfaces()).flat()
    .filter(i => i && i.family === 'IPv4' && !i.internal).map(i => i?.address)
  log(`LAN game is up (NetherNet id ${networkId}). Bedrock ${version} clients on ${v.bind || ips.join(', ') || 'this network'} should see it under Friends → LAN Games.`)
  if (v.offline) log('Joining the remote in offline mode (no Xbox sign-in upstream).')
  if (trace) log(`Writing a debug trace to ${trace.file}`)
  log('Press Ctrl+C to stop.')
})

let stopping = false
async function shutdown (): Promise<void> {
  if (stopping) process.exit(1)
  stopping = true
  log('Stopping…')
  try { await proxy.stop() } catch {}
  process.exit(0)
}
process.on('SIGINT', () => { void shutdown() })
process.on('SIGTERM', () => { void shutdown() })

proxy.start().catch((err: unknown) => {
  const e = err as NodeJS.ErrnoException
  if (e.code === 'EADDRINUSE') {
    console.error('error: UDP port 7551 is already in use. Is Minecraft or another proxy running on this machine?')
  } else {
    console.error('error:', e.message || err)
  }
  process.exit(1)
})
