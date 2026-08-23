# Xonotic WASM (xonweb)

Browser Xonotic that behaves like a normal DarkPlaces UDP client. The engine runs as WebAssembly in Chromium; all game traffic leaves the browser as WebSocket binary frames and a Node proxy turns them into UDP datagrams a dedicated server already understands.

This file is the map. Nested `AGENTS.md` files win for files under their directory.

| Path | Owns |
|---|---|
| [web/AGENTS.md](web/AGENTS.md) | HTML shell, static server (`:9080`) |
| [ws-proxy/AGENTS.md](ws-proxy/AGENTS.md) | WebSocket ↔ UDP proxy (`:8081`); optional FakeTCP hop |
| [assets/AGENTS.md](assets/AGENTS.md) | Files served at `/game/` |
| [test/AGENTS.md](test/AGENTS.md) | Agent harness: CLI against a headless client; the agent judges artifacts |
| [xonotic/AGENTS.md](xonotic/AGENTS.md) | Upstream Xonotic superproject checkout |
| [xonotic/darkplaces/AGENTS.md](xonotic/darkplaces/AGENTS.md) | Engine WASM / GLES / WebSocket patches |
| [xonotic/data/xonotic-data.pk3dir/AGENTS.md](xonotic/data/xonotic-data.pk3dir/AGENTS.md) | QuakeC gamecode |

## Product goal

1. A WASM client that can `connect host:port` through the proxy and play on a stock Xonotic dedicated server (local or public).
2. Map load that is not limited to files already in the first-run cache: connecting to a server whose map is missing must download that pack, then join.
3. Two or more participants in one match, stable (no disconnect, no origin teleport, no persistent hitch).
4. Local play (`map` / connect to a local dedicated) with movement that does not stutter. Visual proof (screenshots/video) plus engine telemetry, not screenshots alone.

The dedicated server must not need a special protocol. It should see a normal UDP client whose source IP is the proxy host.

## Layout

```
xonweb/
├── AGENTS.md                 # this file
├── sync-assets.sh            # rsync subset of Xonotic data → assets/game
├── emsdk/                    # Emscripten SDK (do not clean)
├── web/                      # browser shell + static server
├── ws-proxy/                 # WS↔UDP proxy + optional udp2raw FakeTCP hop
├── assets/game/              # HTTP tree at /game/ (MEMFS basedir)
├── test/                     # agent harness (CLI + artifacts, not a test runner)
└── xonotic/                  # nested Xonotic checkout (gitlink, not a flat copy)
    ├── darkplaces/           # engine (our WASM patches live here)
    ├── data/xonotic-data.pk3dir/
    ├── data/xonotic-maps.pk3dir/
    ├── gmqcc/
    └── d0_blind_id/
```

Repo root on this machine: the directory that contains this file. Do not hardcode `/data/jake/...` or `/home/jake/...`. Older scripts and tests still do; fix them when you touch them.

`xonotic/` is recorded in the parent git as a gitlink (mode `160000`) with its own nested remotes (`darkplaces`, `xonotic-data.pk3dir`, `gmqcc`, …). Do not `git add` the inner tree into the parent. Do not run `./all update` unless the user asked.

Our engine forks live on GitHub: `xonotic/` itself is pushed to `JakeTrock/xonotic`, and inside it **darkplaces is a registered submodule** (`.gitmodules`) pointing at `JakeTrock/darkplaces` — bump that gitlink when the engine tip moves, then bump the outer `xonotic` gitlink here. Upstream remotes are kept under the name `upstream`.

## Ports

| Service | Port | Start |
|---|---|---|
| Web + assets | 9080 | `cd web && node server.js` |
| WS proxy | 8081 | `cd ws-proxy && node server.js` |
| Dedicated (test) | 26000 | see [xonotic/AGENTS.md](xonotic/AGENTS.md) |

## Everyday commands

```bash
# 1. Emscripten (required for engine rebuilds)
source emsdk/emsdk_env.sh

# 2. WASM client
cd xonotic/darkplaces
make emscripten-release
cp darkplaces-wasm.js ../../web/

# 3. QuakeC (only if you changed .qc/.qh)
cd xonotic/gmqcc && make
cd ../data/xonotic-data.pk3dir && make
cp -f {progs,csprogs,menu}.dat ../../../assets/game/xonotic-data.pk3dir/
# then bump Module.assetVersion in xonotic/darkplaces/wasm/pre.js or IDBFS keeps stale .dat

# 4. Native dedicated (host gcc, not emcc)
cd xonotic/darkplaces
make sv-release
./darkplaces-dedicated -xonotic +sv_public 0 +port 26000
```

## Connect path (what “acts as a normal client” means)

```
index.html  Play
  → load darkplaces-wasm.js
  → wasm/pre.js fills MEMFS /game from GET /filelist
  → callMain -basedir /game -game xonotic-data.pk3dir -game xonotic-maps.pk3dir
  → em_wss ws://<host>:8081 binary
  → connect <ip>:<port>
  → LHNET_Write opens ws://proxy/?target=<ip>:<port>
  → proxy UDP ↔ dedicated :26000
```

The HTML Connect / Browse UI is the real menu (`forceqmenu 1` skips `menu.dat`). Backtick toggles the HTML console overlay, not the engine console. Drive the engine from JS with `Module.ccall('em_exec', null, ['string'], [cmd])`.

In-engine `slist` / master queries do not work (client socket is WebSocket). The HTML server browser uses `GET http://proxy:8081/slist`.

## Source of truth (do not mix these up)

| Live | Dead / generated |
|---|---|
| `xonotic/darkplaces/wasm/pre.js` (embedded by `--pre-js`) | `web/pre.js`, `web/original-pre.js` |
| `xonotic/darkplaces/*.c` patches | `web/darkplaces-wasm.js` (copy after build) |
| `assets/game/` (what the browser fetches at `/game/`) | `xonotic/data/` (native dedicated `-basedir`; not served). Extra pk3s in `assets/game/` do not make `stack start --map` work until copied here — see [test/AGENTS.md](test/AGENTS.md) Hitches |

Edit `web/pre.js` and nothing in the running game changes.

## Agent rules

- Read the nested `AGENTS.md` before editing that tree.
- Keep WASM patches behind `#ifdef __EMSCRIPTEN__` / `USE_GLES2`. Do not reformat upstream C or QuakeC.
- Never add `CONFIG_VIDEO_CAPTURE` or `OBJ_VIDEO_CAPTURE` to the WASM target.
- Never call `SDL_GL_SetSwapInterval` during WASM `Host_Init` (breaks the rAF loop).
- Do not hand-edit `web/darkplaces-wasm.js` or `xonotic/darkplaces/darkplaces-wasm.js`.
- Do not `rm -rf` `emsdk/`, `assets/`, `xonotic/`, `*/node_modules`, or `xonotic/darkplaces/build-obj/`.
- Do not flatten `*.pk3dir` folders or re-encode `.tga` / `.ogg`.
- Paths in new code must be repo-relative or derived from `__dirname` / `process.cwd()`, never `/data/jake/...`.
- After a user-visible change, drive the client with [test/AGENTS.md](test/AGENTS.md) (`stack` + `client` CLIs), then **look at** the canvas shots and `state.json`. Do not claim “connect works” from a Join-dialog screenshot. Do not claim two-player from a live-view still or a spectator overlay. Do not add Playwright.
- Two-client / non-xoylent dedicated: follow [test/AGENTS.md](test/AGENTS.md) Hitches (`--map` needs the pk3 in `xonotic/data/`, IDBFS seed, idle-spectate at 60s).

## License

No root LICENSE. Gamecode/data are GPLv3+ (`xonotic/COPYING`). DarkPlaces is GPLv2+ (`xonotic/darkplaces/COPYING`). `web/` and `ws-proxy/` inherit the engine/game licenses for code that ships with them. Do not strip notices.
