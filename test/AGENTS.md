# test/ — agent harness

Scripts an agent runs against a **persistent headless Chromium** that is already playing the WASM client. The agent looks at the artifacts (canvas shots, console, JSON state) and decides pass/fail. There is no test runner, no assertion library, and no locator-based browser tests.

Do **not** add Playwright, Puppeteer, or `@playwright/test`. Do **not** treat the existing `test/*.js` files as the harness — they are dead probes (see [Dead files](#dead-files)).

Parent: [../AGENTS.md](../AGENTS.md). Page bridge: [../web/AGENTS.md](../web/AGENTS.md). Engine `em_exec` / `em_state`: [../xonotic/darkplaces/AGENTS.md](../xonotic/darkplaces/AGENTS.md).

## Why this shape

The product flow this harness drives is the HTML UI on PR 1:

**configuration menu → loading (assets) → server browser → loading (map / connect) → online match**

Do not skip the server browser with a raw `exec connect` unless you are debugging the engine. Pick a server the same way a player does (row click / `connectToServer`, which downloads the map pk3 first).

The WASM client is a real game loop (WebGL, pointer lock, `em_exec`, WebSocket). The harness is a **control plane + artifact dump**. Judgement stays in the agent.

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
test/harness/stack start [--map mint]   # web :9080, proxy :8081, dedicated :26000
test/harness/stack status               # health JSON; non-zero if any service down
test/harness/stack stop
test/harness/stack logs [--svc web|proxy|dedicated]
test/harness/stack netprobe [--addr host:port] [--count 30]
```

`netprobe` compares **direct UDP `getinfo`** to the same query through `ws://127.0.0.1:8081/?target=…`. That isolates the bridge from SwiftShader hitch. Writes `test/artifacts/<run>/netprobe.json` with `verdict.deficient` / `reasons` (the CLI still exits 0 unless the tool itself failed). Default `--addr` is the local dedicated (`127.0.0.1:26000`). For a public empty server, pass that `ip:port`. Local overhead should be a few milliseconds; tens of ms extra, loss, or WS ping ≫ loopback means the proxy is the hitch.

Health:

| Service | Check |
|---|---|
| `web/server.js` | `GET http://127.0.0.1:9080/` → 200 |
| `ws-proxy/server.js` | `GET http://127.0.0.1:8081/` → `{ status: "ok" }` |
| `darkplaces-dedicated -xonotic +sv_public 0 +port 26000` | process alive; optional UDP `getinfo` |

Dedicated command line is owned by `stack` so map/port stay reproducible. Default map for seeded play: **xoylent** if its pk3 is in `assets/`; `_init` for a boot-only smoke. `stack start --map <name>` passes `+map <name>` only (no `g_maplist` pin).

`--map` other than xoylent does **not** pull the pack from `assets/game/`. Dedicated `-basedir` is `xonotic/`; copy the pk3 into `xonotic/data/` first (see [Hitches](#hitches-bringing-two-clients-up)). `getinfo` can time out while `SpawnServer` is still running: if the dedicated pid is alive, wait and `stack status` again — do not `stack stop`.

Logs go to `test/artifacts/<run-id>/stack-<svc>.log`.

### Client (one Chromium, one WASM instance)

Every subcommand takes `[--id a]`. Two clients use **fixed ports** (see Monitor URLs). Default `--id a`.

Unless noted, commands print to stdout **and** write a file under `test/artifacts/<run-id>/<id>/`. The agent reads those files (PNG via vision, JSON/text as text).

#### Session

```bash
test/harness/client start [--id a] [--cdp 9222] [--headed] [--play]
test/harness/client stop  [--id a]
test/harness/client play  [--id a] [--name Player]
test/harness/client ready [--id a] [--timeout 180]          # wait until server browser is up
test/harness/client phase [--id a]
test/harness/client wait-phase [--id a] settings|loading|browser|loading-map|match
```

`start` lands on the **configuration menu**. WASM is not loaded yet. `--play` clicks Play immediately.

#### Monitor URLs (always these ports)

Each headless client runs a live screenshot server plus Chrome DevTools. Open the **live** URL in your own browser to watch the game.

| Client | Live view | Latest frame | Chrome DevTools |
|---|---|---|---|
| `--id a` | http://127.0.0.1:9322/ (LAN: http://10.103.0.115:9080/view/a/) | http://127.0.0.1:9322/shot.png | http://127.0.0.1:9222/ |
| `--id b` | http://127.0.0.1:9323/ (LAN: http://10.103.0.115:9080/view/b/) | http://127.0.0.1:9323/shot.png | http://127.0.0.1:9223/ |

On the LAN, open the **`:9080/view/…` URLs**. The raw 9322/9323 ports bind `0.0.0.0` but are often `ERR_ADDRESS_UNREACHABLE` from other machines (filtered high ports). Chrome DevTools (`9222`/`9223`) is loopback-only.

`client start` and `client urls` print these. Override with `--cdp` / `--view-port` only if the defaults are taken. `stack stop` / `client stop` tear the view server down.

The live view **keeps the last successful PNG** when CDP dies. A frozen “Press SPACE to join” / loading overlay / in-game HUD is not proof the tab is alive. Confirm with `client phase` / `state` (fails with `CDP timeout Runtime.enable after 20000ms` if the renderer is dead) plus dedicated log and `GET http://127.0.0.1:8081/` `connections`. Two frames with **different match clocks** are not the same session.

Phases:

| Phase | What you see |
|---|---|
| `settings` | HTML settings panel, Play enabled |
| `loading` | asset overlay (“Downloading assets…” / “Loading engine…”) |
| `browser` | HTML server browser (after engine start) |
| `loading-map` | map pk3 overlay (`#mapDownloadOverlay`) |
| `connecting` | connect sent, signon not finished |
| `match` | `state.connected` and signon complete |

`start` launches Chromium:

```
--headless=new
--remote-debugging-port=<cdp>
--autoplay-policy=no-user-gesture-required
--disable-gpu-sandbox
http://127.0.0.1:9080/?harness=1
```

Chrome binary: `CHROME_PATH`, then `test/browsers/` (install with `npx --yes @puppeteer/browsers install chrome@stable --path test/browsers`), then `google-chrome` / `chromium`. Prefer real GL (EGL/ANGLE). Software GL is a last resort; say so in `state.json` (`renderer`). Headless on a machine with no `DISPLAY` uses SwiftShader (`--use-gl=swiftshader`); one match renderer is typically **2–2.8 GiB RSS**. `--headed` is the same CDP API, just visible.

`--id a` and `--id b` are **separate Chrome profiles** (`test/artifacts/current/chrome-a` vs `chrome-b`). IDBFS does not share. A cold B re-downloads the whole `/filelist` (~4430 files / ~2825 MB) even when A already cached it. That download is ArrayBuffers in the renderer; it OOMs a 5–6 GiB host long before the kernel OOM killer. A’s skip-cache path is “Skipping 4436 files already in IDBFS cache”. Copying `chrome-a/Default/IndexedDB` into `chrome-b` after `client stop --id b` is the only way we have skipped that download — copy while A is running can be a torn LevelDB.

`client stop` kills `session.pid` + `viewPid` from `clients/<id>.json`. That pid is often **not** the Chrome parent (`pgrep -f remote-debugging-port=`). Leftover Chrome keeps the CDP port; the next `start` then logs `bind() failed: Address already in use` and `database is locked`. Kill by profile path / debugging port, then remove `SingletonLock` / `SingletonSocket` / `SingletonCookie`.

CDP `pickPage` uses the **first** `?harness=1` target. Crash recovery leaves extra tabs (`DarkPlaces-Quake` hung + several `Xonotic WASM`). The hung tab wins, then every `client` command times out on `Runtime.enable`. List `http://127.0.0.1:<cdp>/json/list`, `Target.closeTarget` the extras, keep one live page (title `Xonotic WASM` on the settings panel, or a still-running game). Renderer RSS ~4–8 MB means that tab’s WASM is gone even if the browser process is up.

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

`input +forward --seconds 3` is `exec +forward`, sleep, `exec -forward`. Prefer `em_exec` — it does not need pointer lock.

`wait` matches the **engine console** ring by default (`--stream engine|html|js|all`).

Join from the QC spectator HUD (“Observing / Press SPACE to join”) is **not** reliable from `exec join` or `exec +jump` alone. SDL never saw a key. There is no `client key` command. After `wait-phase match`:

1. Close the HTML server browser (`eval` click `#closeBrowserBtn`). `phase` can be `match` with `serverBrowser: true` — the overlay is still up.
2. `exec join`.
3. Focus `#canvas` and send real Space via CDP `Input.dispatchKeyEvent` (keydown/keyup, `windowsVirtualKeyCode: 32`, a few times). JS `KeyboardEvent` is untrusted and SDL ignores it. Snippet:

```js
// from repo root; ports 9222 = --id a, 9223 = --id b
const { withCdp } = require('./test/harness/lib/cdp');
await withCdp(9222, async (cdp) => {
	await cdp.evaluate('(function(){ var c=document.getElementById("canvas"); if (c) c.focus(); })()', false);
	for (let i = 0; i < 5; i++) {
		await cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', windowsVirtualKeyCode: 32, nativeVirtualKeyCode: 32, key: ' ', code: 'Space', text: ' ' });
		await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', windowsVirtualKeyCode: 32, nativeVirtualKeyCode: 32, key: ' ', code: 'Space' });
		await new Promise((r) => setTimeout(r, 250));
	}
});
```

4. Confirm with a **fresh** `--page` shot (no “Observing”, weapon/health HUD, player name) **and** dedicated `is now playing` **and** `client exec status` → `players: N active`.
5. `input +forward` **immediately**. QC idle-spectates after ~60s with no movement (`Stop idling!` on the HUD; dedicated `was moved to spectators after idling for 60 seconds`). `status` then shows score `-666` and `hidden`. Recover with steps 2–3.

`origin: [0,0,0]` in `state.json` is normal in spectate and has also been seen after a successful join; do not treat it as “not in world”. A near-black canvas with a weapon HUD (mint spawn facing a wall) is still in-world. QC “Your ping … is currently too high to play here” blocks join when the SwiftShader client is hitching (dedicated `Server lag report` with high `% lost`). That is load, not routing.

#### Server browser → match (the product path)

```bash
test/harness/client servers [--id a]                      # refresh /slist, dump rows
test/harness/client pick [--id a] '127.0.0.1:26000' [--map xoylent]
test/harness/client pick [--id a] --local [--map xoylent] # same address if not in the list
```

`pick` clicks a matching browser row when one exists. If the dedicated server is not on `/slist` (typical for `+sv_public 0`), it calls the page’s `connectToServer(addr, map, proxy)` — **`disconnect` if already in a match**, then map download overlay, texture prefetch, then `em_wss` + `connect`. That is the second loading step. Do not `exec connect` instead. A checkerboard world means the prefetch did not run or the files 404d (`/404stats`, js log `[map-assets]`). A second `pick` while `phase` is `match` must leave the old dedicated (console `Disconnected`) and load the new map — it must not stay on the previous server until timeout.

`servers` hits Refresh and waits briefly for `/slist`. Local-only dedicated may return an empty list; `pick --local` still joins.

Always pass `--map <current>` on `pick --local`. The bridge defaults a missing map name to `'unknown'`, and the overlay then tries `cts_unknown.pk3`. If the dedicated already changed maps (see [../xonotic/AGENTS.md](../xonotic/AGENTS.md)), pick that map, not a stale `xoylent`.

`connectToServer` skips `/mapdl/` when any `.pk3` filename under MEMFS `xonotic-maps.pk3dir` / `xonotic-data.pk3dir` **contains** the map name (`mint.pk3` matches `mint`; js log `Map pk3 already in …`). Otherwise it tries `GET /mapfind?name=<map>` (hashed official packs in `xonotic/data/<map>-<hash>-<hash>.pk3`) then `/mapdl/<map>.pk3` / `cts_<map>.pk3`. Official maps are **not** on the community CDN as `<map>.pk3`; without `/mapfind` the overlay 404s and the engine later prints `Map file 'maps/<map>.bsp' not found`. A preloaded extra pack therefore never hits the overlay. `cts_wheresmucki.pk3` does not match map `wheresmucki` until the overlay tries `cts_<map>.pk3`.

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
test/harness/client netprobe [--id a] [--seconds 8] [--hz 10]  # sample em_state + GET proxy /stats; writes netprobe.json
test/harness/client gl     [--id a]                       # WebGL vendor/renderer, context lost?
test/harness/client cvar   [--id a] <name>                # exec the cvar, capture the `"name" is "value"` line
test/harness/client players [--id a]                      # last status / server players if printed
```

`ui` reports booleans: `settingsPanel`, `loadingOverlay`, `toolbar`, `connectDialog`, `serverBrowser`, `htmlConsole`, plus a guess for the Join/Spectate QC overlay (from the last `--page` shot only if you just took one — otherwise “unknown”). Use `shot --page` when `ui` is not enough.

## In-page bridge (`?harness=1`)

Loaded only when the query string is present so a normal player is unchanged.

On load the page stays on the **settings panel**. The agent clicks Play (`client play`). WASM does not start until then.

`window.__xon`:

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
  ui() -> object,                // includes phase, serverCount, mapDownload
  phase() -> string,
  play({name, proxy}),
  servers() -> {servers, rows, status},
  pick(query, mapName),          // row click or window.xonUi.connectToServer
  refreshServers(),
  net() -> object,
  gl() -> object,
}
```

`index.html` exposes `window.xonUi.{connectToServer, showServerBrowser, refreshServerList, getServers}` so `pick` uses the same map-download path as a row click.

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
| `origin` | `[x,y,z]` — `[0,0,0]` is common in spectate and has been seen after a real join; do not fail `join` on this alone |
| `angles` | view angles |
| `velocity` | if cheap to export |
| `ping` | scoreboard ping (ms), 0 until `pings` has run |
| `packetloss` | % of `incoming_netgraph` marked lost |
| `packetsReceived` / `packetsSent` | `cls.netcon` counters — must increase in `netprobe` |
| `sinceLastMessage` | seconds since `cls.netcon->lastMessageTime` |
| `fps` / `frametime` | last client frame (`cl.realframetime`) |
| `mtime` | latest server snapshot timestamp |
| `renderer` | GL renderer string |
| `errors` | recent `Host_Error` / `Connect: failed` |

Add a small `EMSCRIPTEN_KEEPALIVE` `em_state()` in `sys_wasm.c` that fills this JSON from `cls` / `cl` / `host`. Do not invent a second console-scraping protocol if a C export can do it cleanly.

`client grab` writes `frame-000.png`, `frame-001.png`, … plus `grab.jsonl` (one state object per frame). The agent looks at the frames for hitch/jutter and at origin deltas for teleport.

## What the agent judges (base feature set)

Scripts do **not** print PASS/FAIL. The agent does, after reading artifacts. A change is not done until the relevant rows are judged good.

| ID | Drive | Look at | Fail if |
|---|---|---|---|
| `settings` | `client start`; `shot --page settings` | settings panel, Play enabled | skipped to engine without Play |
| `boot` | `client play`; `wait-phase loading`; `wait-phase browser` | overlay then server browser | crash, black canvas, stuck on “Loading engine…” |
| `browser` | `client servers`; `shot --page browser` | list or a clear empty-list status | overlay still up; browser never shown |
| `connect-local` | `pick --local --map xoylent`; `wait-phase match` | map overlay (optional), then `state.connected` + signon done | `Connect: failed`; stuck at signon 1/4 |
| `join` | close HTML browser; `exec join`; CDP Space on `#canvas` | `--page` shot: in the world, not Observing; dedicated `is now playing` | spectator HUD still up; ping-too-high overlay; `origin` alone |
| `move` | `shot before`; `input +forward --seconds 3`; `shot after`; `grab --seconds 2` | shots + origin deltas | no movement; teleport; disconnect |
| `map-download` | `pick` a server whose map is **not** in MEMFS | `loading-map` overlay; pk3 appears in `fs`; then match | connect with missing map; overlay never finishes |
| `mp-2p` | two `--id`s through the same flow on a host that can hold two SwiftShader WASM heaps | both `state.connected`; proxy `connections` ≥ 2; dedicated two `is now playing` and no `dropped (Timed out)`; `status` shows both names | either drops; live-view stills from different clocks; only one `connections` |
| `net` | `stack netprobe` (local and/or `--addr` of an empty public server); in-match `client netprobe --seconds 8` | `verdict.deficient === false`; proxy overhead a few ms vs direct UDP; engine `packetsReceived` rising; no `sinceLastMessage` > 0.5s | proxy p50 tens of ms above direct; getinfo loss; `/stats` drops; stalled `mtime` / origin teleports |

TCP bridge is optional and not part of the base set. Public servers are a product goal; the gated path is local dedicated + proxy.

Do not claim “in-game works” from a Join-dialog screenshot. That was the failure mode of the old probes.

## Agent procedure

```
test/harness/stack start
test/harness/client start --id a
test/harness/client shot --id a --page settings          # configuration menu
test/harness/client play --id a --name Harness
test/harness/client wait-phase --id a loading
test/harness/client wait-phase --id a browser            # after asset load
test/harness/client shot --id a --page browser
test/harness/client servers --id a
test/harness/client pick --id a --local --map xoylent    # map download then connect
test/harness/client wait-phase --id a match
test/harness/client state --id a
test/harness/client shot --id a --page match
# if Join/Spectate is visible (HTML browser may still be up):
test/harness/client eval --id a 'document.getElementById("closeBrowserBtn").click()'
test/harness/client exec --id a 'join'
# plus CDP Space on #canvas — exec join / +jump is not enough
test/harness/client input --id a +forward --seconds 3
test/harness/client shot --id a --canvas moved
test/harness/client grab --id a --seconds 2
test/harness/stack stop
```

Report: judged ID, what you saw in the shots, origin/ping numbers, artifact paths. If the image is ambiguous, `grab` more frames or `start --headed` and look again. Telemetry still wins on disconnect / NaN origin.

Two clients: same sequence with `--id b` (CDP 9223, view 9323) against the same dedicated. Seed B’s IndexedDB from A while both Chromes are stopped, then boot **A to `browser` before starting B’s Play** (see [Hitches](#hitches-bringing-two-clients-up)). After both `wait-phase match`, join **both** (close browser + Space + `input +forward`), then immediately:

```
curl -sS http://127.0.0.1:8081/          # connections must be 2
test/harness/client exec --id a status
test/harness/client players --id a       # both names
tail test/artifacts/<run>/stack-dedicated.log
```

If `connections` is 1, the other tab timed out — do not keep bouncing reconnects; that cycles the dedicated map (xoylent → solarium → warfare) and you are no longer testing the same match. `Client "<name>" dropped (Timed out)` on the dedicated log is the source of truth, not the live view.

`GET /json/list` on 9222/9223 is the extra-tab oracle. Renderer RSS (`ps` on `--type=renderer` for that profile) is the OOM oracle.

## Hitches bringing two clients up

Observed on a local dedicated **mint** 2p run (`stack start --map mint`). Workarounds, not bugs to “fix” mid-session:

| Hitch | What you see | Workaround |
|---|---|---|
| Extra map is only under `assets/game/` | Dedicated log never `SpawnServer: mint` (or loads xoylent). WASM can still `pick --map mint` because `/filelist` has the pk3 | `cp -f assets/game/xonotic-maps.pk3dir/<map>.pk3 xonotic/data/<map>.pk3` **before** `stack start --map <map>`. Dedicated basedir is `xonotic/`, not `assets/`. See [../assets/AGENTS.md](../assets/AGENTS.md) and [../xonotic/AGENTS.md](../xonotic/AGENTS.md) |
| `stack start` prints `dedicated.ok: false` / `getinfo timeout` | Pid is alive; log already has `SpawnServer:` / `Server spawned.` | Wait a few seconds, `stack status`. Do not `stop`/`start` — that appends to the same dedicated log and looks like a map cycle |
| Overlay stuck on “Loading engine…” | `phase` still `loading` after Play | `onEngineReady` should call `showClickToPlay` immediately (`forceqmenu 1` skips menu QC). If the overlay stays, the engine never reached `callMain`. Do not wait 30s. |
| chrome-b re-downloads `/filelist` | B js log is not `Skipping 4436 files already in IDBFS cache`; A hitching | Copy `chrome-a/Default/IndexedDB` → `chrome-b/Default/` while **both** Chromes are stopped. Incomplete B (profile much smaller than A) is a torn/partial cache — recopy. Then boot A to `browser` before B’s Play |
| Local dedicated not in `/slist` | `servers` empty or public-only; `pick` without `--local` fails | `pick --local --map <dedicated map>`. `+sv_public 0` never appears on the master list |
| HTML browser still up in `match` | `phase: match` but `serverBrowser: true`; Space never reaches SDL | `eval` click `#closeBrowserBtn` before join/Space |
| No harness key command | `exec join` / `exec +jump` leave “Press SPACE to join” | CDP `Input.dispatchKeyEvent` snippet above (ports 9222 / 9223) |
| Idle spectate ~60s | HUD `Stop idling!`; dedicated `was moved to spectators after idling for 60 seconds`; `status` score `-666` `hidden` | `input +forward` right after join. Recover with `exec join` + Space. Do not pause a minute to take shots first |
| Dark / empty-looking canvas | mint spawn can face a black wall; file size of `--page` shot much smaller than the other client | Weapon + health HUD + matching match clocks = in-world. Compare both `--page` shots |

Non-xoylent 2p sequence that actually worked:

```
cp -f assets/game/xonotic-maps.pk3dir/mint.pk3 xonotic/data/mint.pk3
# both Chromes stopped:
rm -rf test/artifacts/current/chrome-b/Default/IndexedDB
mkdir -p test/artifacts/current/chrome-b/Default
cp -a test/artifacts/current/chrome-a/Default/IndexedDB test/artifacts/current/chrome-b/Default/
test/harness/stack start --map mint
# if dedicated.ok is false, stack status until getinfo answers
test/harness/client start --id a
test/harness/client play --id a --name PlayerA
test/harness/client wait-phase --id a browser
test/harness/client start --id b
test/harness/client play --id b --name PlayerB
test/harness/client wait-phase --id b browser
test/harness/client pick --id a --local --map mint
test/harness/client wait-phase --id a match
test/harness/client pick --id b --local --map mint
test/harness/client wait-phase --id b match
# close browser, exec join, CDP Space, input +forward — both ids
curl -sS http://127.0.0.1:8081/          # connections: 2
test/harness/client exec --id a status   # map: mint; both names
```

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
- Skip the HTML flow (`play` → wait-phase `browser` → `pick`); do not `exec connect` as the happy path
- Skip Play (`client play` or `start --play`)
- Capture the whole page when you meant the canvas (`shot` defaults to `--canvas`; use `--page` on purpose)
- Confuse host `assets/game/` with MEMFS `/game` — always `fs ls` the browser
- Treat the HTML `#console` overlay as the engine console — use `con --stream engine` (or `--dump`)
- Treat software-GL hitch as a renderer bug without checking `state.renderer`
- Hardcode absolute machine paths
- Leave Chromium/dedicated processes running after `stack stop`
- Trust `http://127.0.0.1:9322/` / `:9323/` after a CDP timeout — the view server replays the last PNG
- Claim `mp-2p` from two first-person stills or from “Press SPACE to join”
- Run two `--id`s on a ~6 GiB host with SwiftShader and call the resulting renderer death a game bug
- `pick --local` without `--map` (becomes `unknown` / `cts_unknown.pk3`)
- `stack start --map` for a pack that exists only under `assets/game/` (dedicated will not see it)
- Treat `getinfo timeout` on a live dedicated pid as a dead stack
- Treat “Loading engine…” after `Engine started, showing UI...` as a hang (`onEngineReady` should have opened the browser)
- Sit idle after join — QC spectates at 60s
- Assume `client stop` reaped Chrome; check the debugging port is free
- Attach CDP to a leftover `DarkPlaces-Quake` tab after a crash reload
