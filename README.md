# bedrock-lan-proxy

Make a remote Minecraft Bedrock server show up under **Friends → LAN Games** on every
console, phone and PC on your network. It speaks NetherNet (the WebRTC-based transport
Bedrock uses since 1.26.60) on both sides, via
[node-nethernet](https://github.com/PrismarineJS/node-nethernet).

```
Bedrock client ──NetherNet, LAN signalling (UDP 7551)──▶ bedrock-lan-proxy
bedrock-lan-proxy ──NetherNet, HTTP signalling (TCP game port) + WebRTC (UDP)──▶ remote server
```

Handy for consoles that can't add custom servers, or just so nobody has to type an address.

## Install

Needs **Node.js 24+** (node-nethernet requires it).

```sh
cd bedrock-lan-proxy
npm install
npm link        # optional: puts `bedrock-lan-proxy` on your PATH
```

Nothing is compiled during install.

## Use

```sh
bedrock-lan-proxy play.example.net
bedrock-lan-proxy 203.0.113.7:19133 --name "Glenn's Server"
bedrock-lan-proxy https://mc.example.net           # server behind HTTPS signalling
bedrock-lan-proxy mc.example.net --offline          # remote has online-mode=false
bedrock-lan-proxy mc.example.net -b 192.168.1.20    # pick the LAN interface
```

Within a few seconds it appears in the LAN list with the remote's name and player count.
Run `bedrock-lan-proxy --help` for all options.

| Option | What it does |
| --- | --- |
| `-p, --port` | Remote game port (default 19132; `host:port` works too) |
| `-n, --name` / `-l, --level` | Override the name / world line shown in the LAN list |
| `-g, --game-version` | Force a game version (default: match the remote) |
| `--offline` | Join the remote without Xbox sign-in |
| `--server-key` | Require this remote server key (`sha256:…`) |
| `-b, --bind` | Local IPv4 for LAN discovery |
| `-m, --max-players` | Players through the proxy at once (default 10) |
| `--profiles` | Where sign-in tokens are cached (default `~/.bedrock-lan-proxy/auth`) |
| `--webrtc` | WebRTC backend override (rarely needed) |
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

## Remote server key

A NetherNet server signs its connection answers with an operator key. Over plain HTTP the
proxy checks the signature but can't tell on its own whether it's the *right* server, so,
like SSH, it trusts the key it sees the first time and remembers it in
`~/.bedrock-lan-proxy/known_servers.json`. If the key ever changes, it refuses to connect
and prints both keys. If the server was legitimately reinstalled, delete its line from that
file. To skip first-use trust, pass the key with `--server-key`. HTTPS addresses are
verified through TLS instead.

## Good to know

- **Versions must match.** Clients, the proxy and the remote all need the same Bedrock
  version (1.26.60 or newer). The proxy auto-detects the remote's; if Minecraft updates
  before `bedrock-protocol` does, run `npm update` (and check `--list-versions`).
- **Firewall:** allow Node.js on private networks. It needs UDP 7551 for LAN discovery
  plus WebRTC traffic on random UDP ports, and outbound TCP to the remote's game port.
- **Don't run Minecraft on the proxy machine at the same time.** Both want UDP port 7551.

## How it works

- **LAN side:** node-nethernet answers discovery broadcasts on UDP 7551 with an
  advertisement mirroring the remote's name and player count, then accepts each client's
  WebRTC connection.
- **Remote side:** the proxy fetches the remote's metadata with `GET /v1/join` on its game
  port, then for each player posts a WebRTC offer to `/v1/join/<id>`, signed with that
  player's identity, and verifies the server's signed answer. This HTTP signalling is
  newer than the npm release of node-nethernet, so the dependency is pinned to a GitHub
  commit. `src/upstream.js` plugs it into bedrock-protocol, which otherwise only knows LAN
  and Xbox-services signalling.
- **In between:** bedrock-protocol's `Relay` terminates each client's game session and
  opens a matching one upstream.
- **No RakNet:** bedrock-protocol still lists native RakNet modules as dependencies.
  `package.json` overrides them with empty stubs (`stubs/`), so nothing gets compiled.
  `npm ls` reports the stubs as "invalid" because they deliberately don't match
  bedrock-protocol's version range; that's expected.

## Test

```sh
npm test
```

Spins up a fake NetherNet remote (HTTP signalling + WebRTC), the proxy and a NetherNet
client on this machine, then checks LAN discovery, the advertised name, login, packets
relayed both ways, the signed identity on the upstream offer, and server-key trust.

## Use as a library

```js
const { LanProxy } = require('bedrock-lan-proxy')
const proxy = new LanProxy({ host: 'play.example.net', name: 'Our Server' })
proxy.on('info', console.log)
proxy.on('auth', ({ player, url, code }) => console.log(player, url, code))
await proxy.start()
```
