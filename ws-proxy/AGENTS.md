# ws-proxy/

WebSocket-to-UDP bridge so the WASM client can talk to a stock Xonotic dedicated server. The browser never sends UDP. Destination is **not** in the packet payload; it is `?target=host:port` on the WebSocket URL.

Parent: [../AGENTS.md](../AGENTS.md). Client URL construction: [../xonotic/darkplaces/AGENTS.md](../xonotic/darkplaces/AGENTS.md) (`lhnet.c`).

## Files

| File | Role |
|---|---|
| `server.js` | HTTP + WS on **8081**. UDP mode (default) and TCP-framed mode |
| `tcp-relay.js` | Optional remote hop: TCP framed ↔ local UDP game server |
| `package.json` | `ws ^8.16.0`. `npm start` → `node server.js` |

## Run

```bash
cd ws-proxy
npm install          # first time
node server.js
# node server.js --port=8081 --default-target=127.0.0.1:26000
```

UDP (what local tests use):

```
ws://localhost:8081/?target=127.0.0.1:26000
Sec-WebSocket-Protocol: binary
```

TCP (only if a relay is listening next to the game):

```
ws://localhost:8081/?target=127.0.0.1:9260&proto=tcp
# plus:
node tcp-relay.js --listen=0.0.0.0:9260 --target=127.0.0.1:26000
```

Binds `0.0.0.0`. Health: `GET /` → `{ status, service, connections }`. `connections` is the count of **open browser WebSockets** (one per WASM client). Two-player on the local dedicated must show `connections: 2`; `1` means the other tab never opened `em_wss` or already dropped. Ctrl+C closes every WS and its UDP/TCP socket.

## Protocol

One WebSocket = one destination. Engine (`lhnet.c` `ws_open_connection`):

```
<proxyUrl>[?|&]target=<ip>:<port>
protocols = "binary"   # always, even if em_wss was given "text"
```

Proxy (`server.js` connection handler):

- `query.target` or `--default-target`. Missing/invalid → close **1008**
- `query.proto` default `udp`; `tcp` switches framing
- `target.split(':')` is **IPv4 only**. `[v6]:port` will not parse
- Subprotocol: prefers `binary` if offered

### UDP mode (default)

| Direction | Framing |
|---|---|
| Browser → proxy | One WS **binary** message = one UDP datagram. Raw DarkPlaces payload (`\xff\xff\xff\xff` OOB, etc.). No extra header |
| Proxy → browser | Each UDP datagram on that socket → one WS binary message |

Text frames are dropped. There is no dest header, sequence number, or ack.

### TCP mode

Same WS binary payloads. On the TCP side: `4-byte big-endian length + payload`, max 1 MiB. Larger frames log and **wipe the parse buffer** (desync). `tcp-relay.js` uses the same framing and emits UDP to `--target`.

Architecture:

```
Browser ←WS→ proxy ←TCP framed→ tcp-relay.js ←UDP→ dedicated
```

Public Xonotic servers are UDP. Do not use TCP mode against them unless that host runs `tcp-relay.js`.

## Socket lifecycle

- **One UDP4 socket per browser WebSocket**, dest fixed at handshake. Two browsers to the same server = two ephemeral source ports on the proxy host.
- Node binds the ephemeral port on first `send`. The dedicated server sees `proxy-ip:ephemeral`.
- UDP mode does **not** filter `rinfo`. Anything that unicasts to that ephemeral port is forwarded into the client.
- WS close/error → `transport.close()`. The server then times the client out.
- Engine side: lazy open on first `LHNET_Write`; peer change closes WS (`reconnecting`) and opens a new `?target=`. One pending packet (64 KiB) is flushed on `onopen`.

`connect localhost:26000` from the browser becomes `target=127.0.0.1:26000` on **whatever host the proxy is running**. A remote proxy with that target hits the **proxy’s** loopback, not the player’s.

## HTTP extras (not game traffic)

| Path | Role |
|---|---|
| `GET /` | Health JSON |
| `GET /slist` | Query official masters (`getservers Xonotic 3 empty full`), dedupe, batch `getinfo` (50), JSON `{ servers, count }`. CORS `*` |
| `GET /resolve?host=` | First A record as `text/plain`. Engine does **not** call this today |
| `OPTIONS` | 204 + CORS |

Masters (from `xonotic-common.cfg`): `dpm4/dpm6.xonotic.xyz:27777`, `master1–4.xonotic.org`. `/slist` ping is proxy→server, not browser→server.

The HTML server browser uses `/slist` because in-engine master queries cannot share the single WS socket.

## Public servers

UDP mode works for any IPv4 dedicated the **proxy host** can reach. The server sees the proxy’s public IP. Caveats:

- WASM `connect` only special-cases `localhost` → `127.0.0.1`. Use `/slist` IPs, not hostnames
- IPv6-only servers: no (`udp4` + IPv4 parse)
- All WASM players share the proxy IP (bans, “too many from one IP”)
- In-game RTT = WS hop + proxy→server. `/slist` ping is only the second leg

## Security

This is an **open UDP (and TCP) relay**. No auth, allowlist, or rate limit. Anyone who can hit `:8081` can emit arbitrary UDP from this host via `?target=`. `/resolve` is an open DNS stub; `/slist` makes the proxy hammer masters and every listed server.

Fine on localhost / trusted LAN. Before binding this to the public internet: dest allowlist (or ignore client `target` and force `--default-target`), bind localhost/VPN, origin/token check, rate limits, consider disabling `/resolve`.

Do not “clean up” the connectionless `\xff\xff\xff\xff` payload or add framing on the UDP path. That would stop being a normal Xonotic client.

## Pitfalls

- `--default-target` is only used when the URL has no `target`. The engine always sends `target=`
- TCP connect failure does not close the WS; traffic just fails
- No WebSocket ping. Idle load balancers can drop the socket; the engine reconnects on the next write (new ephemeral port = a new client on the server)
- Do not delete `node_modules/` as cleanup
