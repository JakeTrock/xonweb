# ws-proxy/

WebSocket-to-UDP bridge so the WASM client can talk to a stock Xonotic dedicated server. The browser never sends UDP. Destination is **not** in the packet payload; it is `?target=host:port` on the WebSocket URL.

Parent: [../AGENTS.md](../AGENTS.md). Client URL construction: [../xonotic/darkplaces/AGENTS.md](../xonotic/darkplaces/AGENTS.md) (`lhnet.c`).

## Files

| File | Role |
|---|---|
| `server.js` | HTTP + WS on **8081**. UDP mode (default) and L7 TCP-framed mode |
| `udp2raw/hop.js` | Fetch/run [udp2raw](https://github.com/wangyu-/udp2raw) FakeTCP hop (preferred when UDP is blocked) |
| `tcp-relay.js` | L7 fallback only: real TCP framed ↔ local UDP. HOL blocking |
| `package.json` | `ws ^8.16.0`. `npm start` → `node server.js` |

## Run

```bash
cd ws-proxy
npm install          # first time
node server.js
# node server.js --port=8081 --default-target=127.0.0.1:26000
```

UDP (what local tests and public servers use):

```
ws://localhost:8081/?target=127.0.0.1:26000
Sec-WebSocket-Protocol: binary
```

FakeTCP hop (when the path from this host to the dedicated cannot carry UDP). Browser stays in UDP mode; udp2raw sits next to the game:

```
# on the dedicated host (needs root / CAP_NET_RAW + iptables):
node udp2raw/hop.js server --listen=0.0.0.0:4096 --target=127.0.0.1:26000 --key=secret

# on the proxy host:
node udp2raw/hop.js client --listen=127.0.0.1:26001 --remote=<dedicated-host>:4096 --key=secret

# WASM still:
ws://localhost:8081/?target=127.0.0.1:26001
connect 127.0.0.1:26001
```

`hop.js fetch` downloads the pinned `20230206.0` linux amd64 binary into `udp2raw/bin/` (gitignored). `--raw-mode` defaults to `faketcp` when `sudo -n` works, else `easy-faketcp` (loopback-only; will not pass a real UDP firewall). Local sandwich: `test/harness/stack start --faketcp` then `stack netprobe --faketcp`.

L7 TCP fallback (only if a middlebox requires a real TCP byte stream):

```
ws://localhost:8081/?target=127.0.0.1:9260&proto=tcp
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
- `perMessageDeflate` is **off**. TCP_NODELAY + keepalive on the HTTP/WS socket. UDP socket is bound immediately, dest is `connect()`ed after an IPv4 lookup, recv/send buffers raised to 4 MiB
- If `ws.bufferedAmount` exceeds 128 KiB the proxy **drops** the datagram (UDP semantics) instead of queueing a hitch into seconds of jitter
- Application-level WS ping every 5s; RTT is on `/stats`

### UDP mode (default)

| Direction | Framing |
|---|---|
| Browser → proxy | One WS **binary** message = one UDP datagram. Raw DarkPlaces payload (`\xff\xff\xff\xff` OOB, etc.). No extra header |
| Proxy → browser | Each UDP datagram on that socket → one WS binary message |

Text frames are dropped. There is no dest header, sequence number, or ack.

### FakeTCP hop (udp2raw)

Not a WebSocket protocol. `server.js` still maps one WS binary message to one UDP datagram. udp2raw wraps that UDP in FakeTCP (looks like TCP to L3/L4 firewalls, stays datagrams: loss and reorder, no retransmission). Cipher/auth default `xor`/`simple` with `--disable-anti-replay` for game latency.

```
Browser ←WS→ proxy ←UDP→ udp2raw client ←FakeTCP→ udp2raw server ←UDP→ dedicated
```

Do not point `em_wss` at udp2raw. The engine cannot speak its tunnel protocol.

### TCP mode (L7 fallback)

Same WS binary payloads. On the TCP side: `4-byte big-endian length + payload`, max 1 MiB. Larger frames log and **wipe the parse buffer** (desync). `tcp-relay.js` uses the same framing and emits UDP to `--target`. This is **real TCP**: a lost packet stalls the match. Prefer FakeTCP unless an L7 proxy is in the way.

```
Browser ←WS→ proxy ←TCP framed→ tcp-relay.js ←UDP→ dedicated
```

Public Xonotic servers are UDP. Do not use TCP mode against them unless that host runs `tcp-relay.js`. Do not use FakeTCP against them unless that host runs `hop.js server`.

## Socket lifecycle

- **One UDP4 socket per browser WebSocket**, dest fixed at handshake. Two browsers to the same server = two ephemeral source ports on the proxy host.
- Node binds the ephemeral port on first `send`. The dedicated server sees `proxy-ip:ephemeral`.
- UDP replies are forwarded only when `rinfo` matches the resolved target (same dest as the engine opened). Do not `socket.connect()` the UDP socket — ICMP errors become `'error'` events and replies get dropped.
- WS close/error → `transport.close()`. The server then times the client out.
- Engine side: lazy open on first `LHNET_Write`; peer change closes WS (`reconnecting`) and opens a new `?target=`. One pending packet (64 KiB) is flushed on `onopen`.

`connect localhost:26000` from the browser becomes `target=127.0.0.1:26000` on **whatever host the proxy is running**. A remote proxy with that target hits the **proxy’s** loopback, not the player’s.

## HTTP extras (not game traffic)

| Path | Role |
|---|---|
| `GET /` | Health JSON (`status`, `connections`, `drops`, `uptimeMs`) |
| `GET /stats` | Per-connection counters: packets, bytes, drops, `bufferedAmount`, WS ping RTT, UDP/WS interarrival. Used by `test/harness/stack netprobe` |
| `GET /getinfo?addr=host:port` | One UDP `getinfo` from the proxy. JSON infostring (includes `mapname`, `clients`). Used by `connectToServer` so a stale `/slist` map does not skip the pack the server is actually on |
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

This is an **open UDP (and TCP) relay**. No auth, allowlist, or rate limit. Anyone who can hit `:8081` can emit arbitrary UDP from this host via `?target=`. `/resolve` is an open DNS stub; `/slist` makes the proxy hammer masters and every listed server. udp2raw’s `-k` only authenticates the FakeTCP hop, not the browser WS.

Fine on localhost / trusted LAN. Before binding this to the public internet: dest allowlist (or ignore client `target` and force `--default-target`), bind localhost/VPN, origin/token check, rate limits, consider disabling `/resolve`.

Do not “clean up” the connectionless `\xff\xff\xff\xff` payload or add framing on the UDP path. That would stop being a normal Xonotic client.

## Pitfalls

- `--default-target` is only used when the URL has no `target`. The engine always sends `target=`
- TCP connect failure does not close the WS; traffic just fails
- FakeTCP (`hop.js server` / `client`) needs root or `sudo -n` for `--raw-mode faketcp -a`. SIGTERM must reach udp2raw so it deletes its iptables chain
- `easy-faketcp` is a no-root loopback test, not a firewall bypass
- Idle load balancers can still drop the socket if they ignore WS pings; the engine reconnects on the next write (new ephemeral port = a new client on the server)
- Do not delete `node_modules/` as cleanup
- Turning `perMessageDeflate` back on, or allowing Nagle, will look like in-game lag even on an empty public server. Measure with `test/harness/stack netprobe --addr <ip:port>` (direct UDP getinfo vs the same query through the WS hop). Local overhead should be a few milliseconds, not tens.
