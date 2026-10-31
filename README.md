# bedrock-lan-proxy

Make a remote Minecraft Bedrock server show up under **Friends → LAN Games** on every
console, phone and PC on your network, using the NetherNet protocol
([node-nethernet](https://github.com/PrismarineJS/node-nethernet)).

```
Bedrock client ──NetherNet / WebRTC (LAN, UDP 7551)──▶ bedrock-lan-proxy ──RakNet──▶ remote server
```

Handy for consoles that can't add custom servers, or just so nobody has to type an address.

## Install

Needs **Node.js 24+** (node-nethernet requires it).

```sh
cd bedrock-lan-proxy
npm install
npm link        # optional: puts `bedrock-lan-proxy` on your PATH
```

## Use

```sh
bedrock-lan-proxy play.example.net
bedrock-lan-proxy 203.0.113.7:19133 --name "Glenn's Server"
bedrock-lan-proxy mc.example.net --offline          # remote has online-mode=false
bedrock-lan-proxy mc.example.net -b 192.168.1.20    # pick the LAN interface
```

Within a few seconds it appears in the LAN list with the remote's MOTD and player count.
Run `bedrock-lan-proxy --help` for all options.

| Option | What it does |
| --- | --- |
| `-p, --port` | Remote port (default 19132; `host:port` works too) |
| `-n, --name` / `-l, --level` | Override the name / world line shown in the LAN list |
| `-g, --game-version` | Force a game version (default: match the remote) |
| `--offline` | Join the remote without Xbox sign-in |
| `-b, --bind` | Local IPv4 for LAN discovery |
| `-m, --max-players` | Players through the proxy at once (default 10) |
| `--profiles` | Where sign-in tokens are cached (default `~/.bedrock-lan-proxy/auth`) |
| `--webrtc`, `--raknet` | Backend overrides (rarely needed) |
| `--log-packets`, `--debug` | Troubleshooting output |

## First join: one-time sign-in

A Bedrock login is signed for the server it's sent to, so the proxy can't pass a player's
login straight through. Instead it joins the remote **as that player** using their own
Microsoft account:

1. The first time someone joins, they're disconnected with a message like
   *"Go to microsoft.com/link and enter code ABCD1234"* (it's printed in the proxy's terminal too).
2. They sign in with the same account they play on.
3. They reconnect. The token is cached per player, so this only happens once.

With `--offline` there's no sign-in at all, but the remote must allow unauthenticated players.

## Good to know

- **Versions must match.** Clients, the proxy and the remote all need the same Bedrock
  version. The proxy auto-detects the remote's; if Minecraft updates before
  `bedrock-protocol` does, run `npm update` (and check `--list-versions`).
- **Firewall:** allow Node.js on private networks. It needs UDP 7551 for discovery plus
  WebRTC traffic on random UDP ports. On Windows, accept the prompt the first time.
- **Don't run Minecraft on the proxy machine at the same time.** Both want UDP port 7551.
- **The remote must speak RakNet** (normal dedicated servers, BDS, Geyser, etc.).

## How it works

- **node-nethernet** answers LAN discovery broadcasts on UDP 7551, handles WebRTC
  signalling, and carries game packets over WebRTC data channels.
- **bedrock-protocol's `Relay`** (built on node-nethernet) terminates each LAN client's
  session and opens a matching one to the remote. Plain byte forwarding isn't possible:
  NetherNet sessions have no `0xFE` batch header and no game-layer encryption, while RakNet
  servers require both.
- The upstream RakNet link uses `raknet-native` when its prebuilt binary loads, otherwise
  the pure-JS `jsp-raknet`. The `.npmrc` sets `ignore-scripts=true` so `npm install`
  doesn't fail trying to compile raknet-native on OS versions it has no binary for.

## Test

```sh
npm test
```

Spins up a fake RakNet server, the proxy and a NetherNet client on this machine, then
checks LAN discovery, the advertised name, login, and packets relayed both ways.

## Use as a library

```js
const { LanProxy } = require('bedrock-lan-proxy')
const proxy = new LanProxy({ host: 'play.example.net', name: 'Our Server' })
proxy.on('info', console.log)
proxy.on('auth', ({ player, url, code }) => console.log(player, url, code))
await proxy.start()
```
