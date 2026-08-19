# test/ — agent harness

Scripts an agent runs against a **persistent headless Chromium** that is already playing the WASM client. The agent looks at the artifacts (canvas shots, console, JSON state) and decides pass/fail. There is no test runner, no assertion library, and no locator-based browser tests.

Do **not** add Playwright, Puppeteer, or `@playwright/test`. Do **not** treat the existing `test/*.js` files as the harness — they are dead probes (see [Dead files](#dead-files)).

Parent: [../AGENTS.md](../AGENTS.md). Page bridge: [../web/AGENTS.md](../web/AGENTS.md). Engine `em_exec` / future `em_state`: [../xonotic/darkplaces/AGENTS.md](../xonotic/darkplaces/AGENTS.md).

## Why this shape

The WASM client is a real game loop (WebGL, pointer lock, `em_exec`, WebSocket). A browser-test framework cannot tell hitch from a Join dialog, and it cannot look at a frame. An agent can: take a shot, read the image, read `state.json`, hold `+forward`, take another shot, compare.

The harness is therefore a **control plane + artifact dump**. Judgement stays in the agent.

## Layout (to implement)

```
test/
  AGENTS.md                 # this file
  harness/
    stack                   # start/stop/status web + proxy + dedicated
    client                  # talk to one headless Chrome session via CDP
    lib/                    # CDP + paths
    bridge.js               # points at web/harness-bridge.js
  artifacts/<run-id>/       # gitignored; shots, state, console, logs
web/harness-bridge.js       # loaded by index.html when ?harness=1
```

`harness/stack` and `harness/client` are CLI entry points the agent shells out to. Keep them repo-relative (`path.join(__dirname, '../..')`). No `/data/jake/...`.

Chrome is driven with the **DevTools Protocol** over a WebSocket (the `ws` package already used by `ws-proxy`, or Node’s `http` + a small WS client). Do not pull a browser-automation framework to do that.

## CLI the agent actually runs

### Stack

```bash
test/harness/stack start          # web :9080, proxy :8081, dedicated :26000
test/harness/stack status         # health JSON; non-zero if any service down
test/harness/stack stop
test/harness/stack logs [--svc web|proxy|dedicated]
```

Health:

| Service | Check |
|---|---|
| `web/server.js` | `GET http://127.0.0.1:9080/` → 200 |
| `ws-proxy/server.js` | `GET http://127.0.0.1:8081/` → `{ status: "ok" }` |
| `darkplaces-dedicated -xonotic +sv_public 0 +port 26000` | process alive; optional UDP `getinfo` |

Dedicated command line is owned by `stack` so map/port stay reproducible. Default map for seeded play: **xoylent** if its pk3 is in `assets/`; `_init` for a boot-only smoke.

Logs go to `test/artifacts/<run-id>/stack-<svc>.log`.

### Client (one Chromium, one WASM instance)

Every subcommand takes `[--id a]`. Two clients: `--id a --cdp 9222` and `--id b --cdp 9223`. Default `--id a`.

Unless noted, commands print to stdout **and** write a file under `test/artifacts/<run-id>/<id>/`. The agent reads those files (PNG via vision, JSON/text as text).

#### Session

```bash
test/harness/client start [--id a] [--cdp 9222] [--headed]
test/harness/client stop  [--id a]
test/harness/client ready [--id a] [--timeout 180]   # wait until engine is up
```

`start` launches Chromium:

```
--headless=new
--remote-debugging-port=<cdp>
--autoplay-policy=no-user-gesture-required
--disable-gpu-sandbox
http://127.0.0.1:9080/?harness=1
```

Chrome binary: `CHROME_PATH`, then `test/browsers/` (install with `npx --yes @puppeteer/browsers install chrome@stable --path test/browsers`), then `google-chrome` / `chromium`. Prefer real GL (EGL/ANGLE). Software GL is a last resort; say so in `state.json` (`renderer`). `--headed` is the same CDP API, just visible.

#### Drive the engine

```bash
test/harness/client exec  [--id a] 'em_wss ws://127.0.0.1:8081 binary'
test/harness/client exec  [--id a] 'connect 127.0.0.1:26000'
test/harness/client exec  [--id a] 'join'
test/harness/client exec  [--id a] '+forward'
test/harness/client exec  [--id a] '-forward'
test/harness/client input [--id a] +forward --seconds 3
test/harness/client wait  [--id a] 'Connection established' [--timeout 60]
test/harness/client eval  [--id a] 'JS expression'          # escape hatch
```

`input +forward --seconds 3` is `exec +forward`, sleep, `exec -forward`. Key events to the canvas are a fallback if `+forward` does not move (focus/pointer-lock). Prefer `em_exec` — it does not need pointer lock.

`wait` matches the **engine console** ring by default (`--stream engine|html|js|all`).

#### Screenshots

```bash
test/harness/client shot  [--id a] [name]                 # canvas only (default)
test/harness/client shot  [--id a] --canvas [name]        # same
test/harness/client shot  [--id a] --page [name]          # full page: HTML overlays + canvas
test/harness/client shot  [--id a] --ui [name]            # page minus the canvas (settings, join, browser)
test/harness/client grab  [--id a] [--seconds 3] [--hz 10]
```

- `--canvas` is what the engine drew. Use this for hitch / world / missing textures.
- `--page` is what a player would see, including the Join dialog and toolbar. Use this to notice you never `join`ed.
- `--ui` is for overlay bugs without the 3D view.

`shot` writes `artifacts/<run>/<id>/<name>.png` and prints that path. Default name is a timestamp. The agent `read_file`s the PNG.

`grab` writes `frame-000.png`… plus `grab.jsonl` (one `state` object per frame).

#### In-game / engine console

Three streams. Do not mix them up.

| Stream | What it is |
|---|---|
| `engine` | DarkPlaces `Con_Printf` / `Module.print` + `printErr` — **this is the in-game console** |
| `html` | The HTML overlay `#console` in `index.html` (a copy of print, truncated to 200 DOM lines) |
| `js` | `window.console` + `pageerror` (loader, fetch, JS exceptions) |

```bash
test/harness/client con   [--id a]                        # engine ring, last 200 lines
test/harness/client con   [--id a] --tail 50
test/harness/client con   [--id a] --grep Host_Error
test/harness/client con   [--id a] --since 10s            # only lines after T
test/harness/client con   [--id a] --stream engine|html|js|all
test/harness/client con   [--id a] --dump                 # exec condump, then fs-cat the file
test/harness/client log   [--id a] [...]                  # alias of `con --stream all`
```

`con` prints text and writes `con-engine.txt` (and `con-html.txt` / `con-js.txt` when those streams are requested).

`--dump` is the full history: `exec condump harness/condump.txt` then read that path from MEMFS. Use it when the ring was truncated. Prefer the live ring for `wait` / `--grep`.

#### Browser filesystem the WASM loads from

The engine’s basedir is MEMFS `/game` (IDBFS-backed). That is **not** the same as `assets/game/` on disk until a fetch has succeeded. Query MEMFS, not the host.

```bash
test/harness/client fs ls      [--id a] [path]            # default /game
test/harness/client fs tree    [--id a] [path] [--depth 2]
test/harness/client fs stat    [--id a] <path>
test/harness/client fs cat     [--id a] <path>            # text; --max-bytes N
test/harness/client fs find    [--id a] <glob>            # e.g. '**/*.bsp' '**/progs.dat'
test/harness/client fs has     [--id a] <path>            # prints {exists, size} JSON
test/harness/client fs downloads [--id a]                 # Module._downloadedFiles, errors, assetVersion
test/harness/client fs compare [--id a]                   # MEMFS vs GET /filelist: missing / extra / size mismatch
test/harness/client fs 404s    [--id a]                   # GET /404stats (asset server, same origin)
test/harness/client fs filelist [--id a]                  # GET /filelist (what preload *will* try to fetch)
```

Paths may be `/game/...` or gamedir-relative (`xonotic-data.pk3dir/progs.dat`). Write JSON for `ls` / `stat` / `compare` / `has` so the agent can parse; `cat` is raw text (or a note `{binary:true, size}` if the file is not text).

`compare` is the map-download oracle: a pk3 that is on the asset server but missing in MEMFS was never fetched; a 404 in `fs 404s` is a preload miss that pre.js will **not retry** until `assetVersion` changes.

#### Other introspection

```bash
test/harness/client state  [--id a]                       # telemetry JSON (see below)
test/harness/client ui     [--id a]                       # which HTML overlays are visible
test/harness/client net    [--id a]                       # proxy URL, WS open, last target
test/harness/client gl     [--id a]                       # WebGL vendor/renderer, context lost?
test/harness/client cvar   [--id a] <name>                # exec the cvar, capture the `"name" is "value"` line
test/harness/client players [--id a]                      # last status / server players if printed
```

`ui` reports booleans: `settingsPanel`, `loadingOverlay`, `toolbar`, `connectDialog`, `serverBrowser`, `htmlConsole`, plus a guess for the Join/Spectate QC overlay (from the last `--page` shot only if you just took one — otherwise “unknown”). Use `shot --page` when `ui` is not enough.

## In-page bridge (`?harness=1`)

Loaded only when the query string is present so a normal player is unchanged.

On load:

1. Fill default settings (or skip the panel) and click **Play**. WASM does not start until Play.
2. Install `window.__xon`:

```js
{
  ready: boolean,
  exec(cmd) -> void,                 // Module.ccall('em_exec', ...)
  state() -> object,
  shot({target: 'canvas'|'page'|'ui'}) -> data URL,
  con: {
    engine: [{t, text, err}],        // Module.print / printErr ring
    html:   [{t, text, err}],        // #console DOM
    js:     [{t, text, type}],       // console.* + pageerror
  },
  fs: {
    ls(path), stat(path), cat(path, maxBytes),
    find(glob), has(path), tree(path, depth),
    downloads(),                     // preload bookkeeping
  },
  ui() -> object,
  net() -> object,
  gl() -> object,
}
```

3. Hook `Module.print` / `printErr` **without replacing** the HTML page’s hooks (compose them). Ring size: several thousand engine lines.
4. `fs.*` is Emscripten `FS` on `/game`. Walks must not hang on a full 2.8 GB tree: `ls` is one directory, `tree` is depth-capped, `find` filters by glob.

If `em_state` exists as a WASM export, `state()` prefers that. Otherwise scrape what JS can already see and whatever `em_exec` can print.

Engine full console history fallback: `exec('condump harness/condump.txt')` then `fs.cat('/game/xonotic-maps.pk3dir/harness/condump.txt')` (last `-game` is the write gamedir). If that path 404s, try `xonotic-data.pk3dir/` and `/game/`.

## Telemetry (`state.json`)

Minimum the agent needs to judge movement and net:

| Field | Meaning |
|---|---|
| `ready` | engine main has run |
| `map` | current map name |
| `connected` | past signon, in a server |
| `signon` | signon stage (must leave 1/4) |
| `origin` | `[x,y,z]` |
| `angles` | view angles |
| `velocity` | if cheap to export |
| `frametime` / `fps` | last frame |
| `ping` | if known |
| `renderer` | GL renderer string |
| `errors` | recent `Host_Error` / `Connect: failed` |

Add a small `EMSCRIPTEN_KEEPALIVE` `em_state()` in `sys_wasm.c` that fills this JSON from `cls` / `cl` / `host`. Do not invent a second console-scraping protocol if a C export can do it cleanly.

`client grab` writes `frame-000.png`, `frame-001.png`, … plus `grab.jsonl` (one state object per frame). The agent looks at the frames for hitch/jutter and at origin deltas for teleport.

## What the agent judges (base feature set)

Scripts do **not** print PASS/FAIL. The agent does, after reading artifacts. A change is not done until the relevant rows are judged good.

| ID | Drive | Look at | Fail if |
|---|---|---|---|
| `boot` | `stack start`; `client start`; `client ready` | shot of canvas; `state.ready`; console | crash, black canvas, `Host_Error`, Play never clicked |
| `connect-local` | `exec em_wss …`; `exec connect 127.0.0.1:26000`; `wait 'Connection established'` | `state.connected`, `state.signon`, shot | stuck at signon 1/4; `Connect: failed`; no `WebSocket connected` |
| `join` | `exec join` | shot: no Join/Spectate dialog; `state.origin` is in the world | still on the join overlay |
| `move` | `shot before`; `input +forward --seconds 3`; `shot after`; `grab --seconds 2` | both shots (vision); origin deltas in `grab.jsonl` | origin unchanged; a jump of impossible distance; disconnect; frames show hitch/jutter |
| `map-seeded` | dedicated `+map xoylent` (or whatever is in `assets/`) | 3D world in the shot, not a loading splash | missing textures as a full pink/black void; `Host_Error` |
| `map-download` | dedicated on a map **not** in the first preload; `eval` `Module.downloadPack` then `exec fs_rescan` then connect | network/console that the pk3 arrived; world shot | connect without the map; engine curl (does not work in WASM) |
| `mp-2p` | `client start --id a` and `--id b`; both connect+join | two `state.json`; dedicated log `clients` ≥ 2; a shot from each | either drops; dedicated never sees 2 |

TCP bridge is optional and not part of the base set. Public servers are a product goal; the gated path is local dedicated + proxy.

Do not claim “in-game works” from a Join-dialog screenshot. That was the failure mode of the old probes.

## Agent procedure

```
test/harness/stack start
test/harness/client start --id a
test/harness/client ready --id a
test/harness/client exec --id a 'em_wss ws://127.0.0.1:8081 binary'
test/harness/client exec --id a 'connect 127.0.0.1:26000'
test/harness/client wait --id a 'Connection established'
test/harness/client state --id a
test/harness/client con --id a --grep 'Connect|WebSocket|Host_Error'
test/harness/client fs has --id a xonotic-data.pk3dir/progs.dat
test/harness/client fs compare --id a          # preload holes
test/harness/client shot --id a --page signon  # includes Join overlay
test/harness/client shot --id a --canvas world
# read_file both PNGs — if Join dialog still up, exec join
test/harness/client exec --id a 'join'
test/harness/client shot --id a --page spawned
test/harness/client input --id a +forward --seconds 3
test/harness/client shot --id a --canvas moved
test/harness/client grab --id a --seconds 2
test/harness/client con --id a --tail 80
# read_file moved.png + grab frames; read grab.jsonl origins; read con-engine.txt
test/harness/stack stop
```

Report: judged ID, what you saw in the shots, origin/ping numbers, artifact paths. If the image is ambiguous, `grab` more frames or `start --headed` and look again. Telemetry still wins on disconnect / NaN origin.

Two clients: same sequence with `--id b --cdp 9223` against the same dedicated.

## Implementation order

Done: bridge, `client` CLI, `stack` CLI, `em_state` in `sys_wasm.c`, `input` / `grab`, `--id`, dead probes removed.

After changing `em_state` / `sys_wasm.c`, rebuild WASM (`make emscripten-release` and copy `darkplaces-wasm.js` to `web/`) or `state()` falls back to console scraping.

## Dead files

Old Playwright probes were removed. `screenshot*.png` leftovers stay gitignored. Do not reintroduce Playwright.

Console string table they were scraping (still useful for `client wait`):

| Event | String |
|---|---|
| Engine starting | `Starting engine...` |
| Menu QC (may be skipped by `forceqmenu 1`) | `menu: program loaded` |
| HTML took over | `Auto-navigated` |
| WS | `Opening WebSocket` / `WebSocket connected` |
| Handshake | `Connection established` |
| Fail | `Connect: failed`, `Host_Error` |

## Do not

- Add Playwright, Puppeteer, or a screenshot-diff CI
- Encode pass/fail in the CLI (exit non-zero only for *tool* errors: Chrome died, timeout waiting for a string, stack not up)
- Skip Play (`?harness=1` must click it)
- Capture the whole page when you meant the canvas (`shot` defaults to `--canvas`; use `--page` on purpose)
- Confuse host `assets/game/` with MEMFS `/game` — always `fs ls` the browser
- Treat the HTML `#console` overlay as the engine console — use `con --stream engine` (or `--dump`)
- Treat software-GL hitch as a renderer bug without checking `state.renderer`
- Hardcode absolute machine paths
- Leave Chromium/dedicated processes running after `stack stop`
