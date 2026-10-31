#!/usr/bin/env node
'use strict'

const { parseArgs } = require('node:util')
const os = require('node:os')
const pkg = require('../package.json')

const [major] = process.versions.node.split('.').map(Number)
if (major < 24) {
  console.error(`bedrock-lan-proxy needs Node.js 24 or newer (node-nethernet requires it). You have ${process.version}.`)
  process.exit(1)
}

const { LanProxy, supportedVersions, DEFAULT_PROFILES } = require('../src/proxy')

const HELP = `
bedrock-lan-proxy ${pkg.version}
Make a remote Minecraft Bedrock server appear in the Friends tab as a LAN game.

Usage:
  bedrock-lan-proxy <host>[:port] [options]

Options:
  -p, --port <n>           Remote server port (default 19132)
  -n, --name <text>        Name shown in the LAN list (default: the remote's MOTD)
  -l, --level <text>       World name shown under it (default: the remote's level name)
  -g, --game-version <v>   Game version to speak, e.g. 1.21.90 (default: match the remote)
      --offline            Join the remote without Xbox sign-in (remote must have online-mode off)
  -b, --bind <ip>          Local IPv4 address for LAN discovery (default: all interfaces)
  -m, --max-players <n>    Max players through the proxy at once (default 10)
      --profiles <dir>     Where upstream sign-in tokens are cached
                           (default ${DEFAULT_PROFILES})
      --webrtc <backend>   werift (default), wrtc, or auto
      --raknet <backend>   Upstream RakNet: auto (default), raknet-native, or jsp-raknet
      --debug              Show extra diagnostic messages
      --log-packets        Print every relayed packet (very noisy)
      --list-versions      Print supported game versions and exit
  -h, --help               Show this help
      --version            Show the tool version

Examples:
  bedrock-lan-proxy play.example.net
  bedrock-lan-proxy 203.0.113.7:19133 --name "Glenn's Server"
  bedrock-lan-proxy mc.local --offline -b 192.168.1.20
`

function fail (msg) {
  console.error(`error: ${msg}\nRun with --help for usage.`)
  process.exit(2)
}

let args
try {
  args = parseArgs({
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
      raknet: { type: 'string' },
      debug: { type: 'boolean' },
      'log-packets': { type: 'boolean' },
      'list-versions': { type: 'boolean' },
      help: { type: 'boolean', short: 'h' },
      version: { type: 'boolean' }
    }
  })
} catch (err) {
  fail(err.message)
}

const { values: v, positionals } = args

if (v.help) { console.log(HELP); process.exit(0) }
if (v.version) { console.log(pkg.version); process.exit(0) }
if (v['list-versions']) { console.log(supportedVersions().join('\n')); process.exit(0) }

if (positionals.length !== 1) fail('give exactly one remote server, like play.example.net or 1.2.3.4:19132')

// Accept host, host:port, or [ipv6]:port
let host = positionals[0]
let port = 19132
const m = host.match(/^\[(.+)\](?::(\d+))?$/) || host.match(/^([^:]+)(?::(\d+))?$/)
if (m) { host = m[1]; if (m[2]) port = Number(m[2]) }
if (v.port) port = Number(v.port)
if (!Number.isInteger(port) || port < 1 || port > 65535) fail(`invalid port ${v.port ?? port}`)

const maxPlayers = v['max-players'] ? Number(v['max-players']) : undefined
if (maxPlayers !== undefined && (!Number.isInteger(maxPlayers) || maxPlayers < 1)) fail('--max-players must be a positive whole number')

if (v.webrtc && !['werift', 'wrtc', 'auto'].includes(v.webrtc)) fail('--webrtc must be werift, wrtc or auto')
if (v.raknet && !['auto', 'raknet-native', 'jsp-raknet'].includes(v.raknet)) fail('--raknet must be auto, raknet-native or jsp-raknet')

const stamp = () => new Date().toLocaleTimeString()
const log = (...a) => console.log(`[${stamp()}]`, ...a)

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
  webrtc: v.webrtc,
  raknet: v.raknet,
  logPackets: v['log-packets']
})

proxy.on('info', msg => log(msg))
proxy.on('warn', msg => log('warning:', msg))
if (v.debug) proxy.on('debug', msg => log('debug:', msg))
proxy.on('remote', r => log(`Remote ${host}:${port} → "${r.motd}" v${r.version}, ${r.playersOnline}/${r.playersMax} online`))
proxy.on('auth', ({ player, url, code }) => {
  log(`${player} needs a one-time Microsoft sign-in for the remote server:`)
  log(`    open ${url} and enter ${code}`)
  log('    (they were shown the same code in-game; they can reconnect once signed in)')
})
proxy.on('error', err => log('error:', err.message || err))
proxy.on('listening', ({ networkId, version }) => {
  const ips = Object.values(os.networkInterfaces()).flat()
    .filter(i => i && i.family === 'IPv4' && !i.internal).map(i => i.address)
  log(`LAN game is up (NetherNet id ${networkId}). Bedrock ${version} clients on ${v.bind || ips.join(', ') || 'this network'} should see it under Friends → LAN Games.`)
  if (v.offline) log('Joining the remote in offline mode (no Xbox sign-in upstream).')
  log('Press Ctrl+C to stop.')
})

let stopping = false
async function shutdown () {
  if (stopping) process.exit(1)
  stopping = true
  log('Stopping…')
  try { await proxy.stop() } catch {}
  process.exit(0)
}
process.on('SIGINT', shutdown)
process.on('SIGTERM', shutdown)

proxy.start().catch(err => {
  if (err.code === 'EADDRINUSE') {
    console.error('error: UDP port 7551 is already in use. Is Minecraft or another proxy running on this machine?')
  } else {
    console.error('error:', err.message || err)
  }
  process.exit(1)
})
