# web/

Browser shell and the static file server. Players and the agent harness both hit `http://localhost:9080/`. The harness uses `?harness=1` (see [../test/AGENTS.md](../test/AGENTS.md)).

Parent: [../AGENTS.md](../AGENTS.md). Engine preload lives in [../xonotic/darkplaces/AGENTS.md](../xonotic/darkplaces/AGENTS.md) (`wasm/pre.js`), not here.

## Files

| File | Role |
|---|---|
| `index.html` | Settings panel, canvas, loading overlay, HTML console, Connect dialog, server browser, `Module` setup |
| `server.js` | Static server on **9080**. No CLI flags, no env vars |
| `darkplaces-wasm.js` | **Generated** single-file Emscripten blob. Do not edit |
| `pre.js` | **Stale.** Not passed to `--pre-js`. Do not treat as live |
| `original-pre.js` | Even older preload stub. Archive only |
| `harness-bridge.js` | `?harness=1` only: auto-Play, `window.__xon` `{ready, exec, state, shot, con, fs, ui, net, gl}` |

## Run

```bash
cd web && node server.js
# http://localhost:9080/
# /game/* → ../assets/game/*
```

After an engine rebuild:

```bash
cp ../xonotic/darkplaces/darkplaces-wasm.js .
```

## Server behavior (`server.js`)

- `/` → `index.html`
- `/game/<path>` → `../assets/game/<path>` (files only; directories 404)
- `/filelist` → JSON `[{path, size}, ...]` of every file under `assets/game/` (used by **compiled** `wasm/pre.js`)
- `/404stats` → JSON of 404 paths/counts (use this when a texture/sound is missing)
- Path traversal blocked (resolved path must stay under `web/` or `assets/`)
- Headers on every response: `Cross-Origin-Opener-Policy: same-origin`, `Cross-Origin-Embedder-Policy: require-corp`, `Access-Control-Allow-Origin: *`
- `Cache-Control: no-store` only for `.js` and `.html` (so a new WASM blob is picked up). Asset files can be cached by the browser
- `Range` → 206. Keep COOP/COEP on range responses if you touch this

MIME: `.pk3` is `application/zip`. Unknown extensions are `application/octet-stream` (fine for `fetch` → MEMFS).

## Boot sequence

1. Page load shows the **settings panel**. WASM is **not** loaded yet.
2. User (or a test) clicks **Play** (`#playBtn`). That click is the audio-autoplay gesture.
3. `generateAutoexec()` → `Module.writeSettings(cfg)` (queued; MEMFS does not exist yet).
4. Overlay shows. `<script src="darkplaces-wasm.js">` is injected.
5. Embedded `xonotic/darkplaces/wasm/pre.js` `preRun`:
   - mount IDBFS on `/game`
   - `GET /filelist`, download (or skip cached) files into `/game/<path>`
   - write `/game/xonotic-data.pk3dir/autoexec.cfg` (`forceqmenu 1`, vid size, then the settings block)
   - `Module.callMain(['-basedir','/game','-game','xonotic-data.pk3dir','-game','xonotic-maps.pk3dir'])`
6. HTML `print`/`printErr` watch for `menu: program loaded`, then `showClickToPlay()`: hide overlay, show toolbar, `em_wss <proxy> binary`, `menu_cmd nexposee`, open the HTML server browser. **30s fallback** because `forceqmenu 1` may skip that print.

Pointer lock is SDL relative-mouse after the user clicks the canvas. There is no extra JS lock helper.

## Talking to the engine

```js
Module.ccall('em_exec', null, ['string'], ['em_wss ws://localhost:8081 binary']);
Module.ccall('em_exec', null, ['string'], ['connect 127.0.0.1:26000']);
```

`em_exec` is `EMSCRIPTEN_KEEPALIVE` (`sys_wasm.c`). Keep `ccall`, `callMain`, `FS`, `IDBFS` in `EXPORTED_RUNTIME_METHODS` (see DarkPlaces `makefile.inc`).

Connect dialog and server-browser rows do the same `em_wss` then `connect`, with a 500ms delay. TCP mode appends `?proto=tcp` to the proxy URL and connects to the tcp-relay port, not 26000.

Server list: convert `ws://host:8081` → `http://host:8081/slist`. After Play, proxy inputs are rewritten to `ws://` + `location.hostname` + `:8081` so a non-localhost page still finds the proxy.

Backtick / `#consoleBtn` toggles the HTML log overlay (`#console`). That is **not** the engine console. The harness `client con` reads `Module.print` (engine) by default; `client con --stream html` is this overlay.

## Harness bridge (`?harness=1`)

Only for the agent CLI in [../test/AGENTS.md](../test/AGENTS.md). A normal visit without the query string must be unchanged.

The bridge composes `Module.print` / `printErr` (do not replace the HTML hooks) into `window.__xon.con.engine`. `window.__xon.fs` is Emscripten `FS` rooted at `/game` (the WASM basedir). `shot({target:'canvas'|'page'|'ui'})` is how `client shot` gets pixels. `fs.compare` diffs MEMFS against `GET /filelist`; `fs.404s` is `GET /404stats`.

## Settings → autoexec

Written by compiled pre.js, not by the HTML itself:

```
forceqmenu 1
set cl_allow_uid2name 0
vid_fullscreen 0
vid_desktopfullscreen 0
set net_connecttimeout 60
set vid_width <innerWidth>
set vid_height <innerHeight>
name / _cl_playermodel / _cl_playerskin / _cl_color
volume / bgmvolume / fov / vid_pixelheight
quality cvars (r_shadow_*, r_glsl, cl_decals, r_coronas)
net_slist_favorites
```

`forceqmenu 1` means the HTML UI **is** the menu. Do not wait on in-engine Multiplayer screens in tests.

## What to edit vs not

- UI, connect flow, server browser → `index.html`
- Headers, `/filelist`, MIME, caching → `server.js`
- What gets downloaded into MEMFS → `xonotic/darkplaces/wasm/pre.js` then rebuild + copy JS here
- Do not point `--pre-js` at `web/pre.js` without reconciling it with `/filelist` + IDBFS + maps gamedir
- Do not drop COOP/COEP
- Do not flatten `/game/` or rename `*.pk3dir`

## Pitfalls

- Tests that skip `#playBtn` never load WASM.
- `web/pre.js` still describes on-demand fetch. The compiled pre.js downloads the **entire** `/filelist` up front. There is no live FS hook for missing files mid-game.
- `Module.downloadPack(url, filename)` exists in compiled pre.js and is **not called** from this HTML. After a successful pack write the page must `em_exec fs_rescan` before `connect`.
- Failed fetches in pre.js are marked downloaded and never retried until `assetVersion` changes or IDBFS is cleared.
- Linux paths are case-sensitive. Use `/404stats`.
- `localhost` in `connect` is rewritten in the engine to `127.0.0.1` (browser `gethostbyname` is useless). Other hostnames will fail; use dotted IPv4 from `/slist`.
