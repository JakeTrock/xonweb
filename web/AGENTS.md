# web/

Browser shell and the static file server. Players and the agent harness both hit `http://localhost:9080/`. The harness uses `?harness=1` (see [../test/AGENTS.md](../test/AGENTS.md)).

Parent: [../AGENTS.md](../AGENTS.md). Engine preload lives in [../xonotic/darkplaces/AGENTS.md](../xonotic/darkplaces/AGENTS.md) (`wasm/pre.js`), not here.

## Files

| File | Role |
|---|---|
| `index.html` | Settings panel, canvas, loading overlay, HTML console, Connect dialog, server browser, `Module` setup |
| `map-assets.js` | On connect: parse BSP texture lump, fetch shaders + referenced images/env into MEMFS, persist IDBFS |
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
- `/filelist` → JSON `[{path, size}, ...]` of every file under `assets/game/` (used by **compiled** `wasm/pre.js`). Does **not** include `xonotic/data/`
- `/dirlist?prefix=` → JSON `{prefix, files, truncated}` of files under that `/game/` prefix from `assets/game` **then** `xonotic/data` (used to prefetch map shaders/textures). Assets win on duplicate paths
- `/mapfind?name=<map>` → JSON `{files:[{path,size,filename}]}` of local hashed/named `.pk3` packs whose filename contains the map (assets gamedirs, then `xonotic/data/*.pk3`). `connectToServer` installs the first hit into MEMFS when `/mapdl/<map>.pk3` would 404
- `/404stats` → JSON of 404 paths/counts (use this when a texture/sound is missing)
- `/view/a/` and `/view/b/` → live screenshots of the harness Chromes (proxies `127.0.0.1:9322` / `:9323`). Use these on the LAN; raw `:9322`/`:9323` are often unreachable even when `:9080` works
- Path traversal blocked (resolved path must stay under `web/` or `assets/`)
- Headers on every response: `Cross-Origin-Opener-Policy: same-origin`, `Cross-Origin-Embedder-Policy: require-corp`, `Cross-Origin-Resource-Policy: same-origin`. CORS echoes the request `Origin` (never `*`) so credentialed `fetch('/filelist')` works on a LAN IP, not only on localhost
- `Cache-Control: no-store` for `.js` and `.html` (so a new WASM blob is picked up). Map packs/textures/sounds/models under `/game/` and `/mapdl/` get `public, max-age=604800`. `.dat` / `.cfg` are not cached (gamecode changes)
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
6. HTML `print`/`printErr` watch for `menu: program loaded` / `menu: program is not loaded`, then `showClickToPlay()`: hide overlay, show toolbar, `em_wss <proxy> binary`, `togglemenu 0`, open the HTML **server browser**. **30s fallback** if that print never comes. `forceqmenu 1` skips menu QC, so the usual hitch is: js log `Engine started, waiting for menu QC...` while the overlay still says “Loading engine…” and `phase` is `loading`. Wait for the fallback (`wait-phase browser`); do not restart Chrome.
7. Player picks a server row → `connectToServer(addr, map, proxy)`: **`disconnect` first** if already in a match, then skip download if a MEMFS `.pk3` **filename** contains the map name; otherwise `#mapDownloadOverlay` via `/mapdl/` + `downloadPack`. Then `map-assets.js` prefetches that BSP’s shaders + referenced textures from `/game/` (assets, then `xonotic/data`) into MEMFS, Cache Storage (`xon-postboot-v1`), and IDBFS, `fs_rescan`, then `em_wss` + `connect`. The checkerboard notexture is only used if a file 404s. A second pick while in-match leaves the old dedicated immediately; a later pick cancels an in-flight download.
8. In-match QC Join/Spectate may still appear. `em_exec('join')` is necessary but often **not** sufficient — the HUD says Press SPACE; SDL needs a real key on `#canvas`. Close `#serverBrowser` (`#closeBrowserBtn`); `phase() === 'match'` can still have the browser overlay up.

`window.__xon.pick(query, mapName)` falls back to `connectToServer` with `mapName || 'unknown'`. Harness `pick --local` without `--map` therefore requests `cts_unknown.pk3`. Pass the dedicated’s current map.

This is the flow the agent harness drives: settings → loading → browser → map loading → match.

Pointer lock is SDL relative-mouse after the user clicks the canvas. There is no extra JS lock helper.

## Talking to the engine

```js
Module.ccall('em_exec', null, ['string'], ['em_wss ws://localhost:8081 binary']);
Module.ccall('em_exec', null, ['string'], ['connect 127.0.0.1:26000']);
```

`em_exec` is `EMSCRIPTEN_KEEPALIVE` (`sys_wasm.c`). Keep `ccall`, `callMain`, `FS`, `IDBFS` in `EXPORTED_RUNTIME_METHODS` (see DarkPlaces `makefile.inc`).

Server-browser rows call `connectToServer` (`disconnect`, map download, then `em_wss` + `connect` with **no** delay). The Connect dialog uses the same path. TCP mode appends `?proto=tcp` to the proxy URL. `window.xonUi.connectToServer` is the same function the harness `pick` uses.

Server list: convert `ws://host:8081` → `http://host:8081/slist`. After Play, proxy inputs are rewritten to `ws://` + `location.hostname` + `:8081` so a non-localhost page still finds the proxy.

Backtick / `#consoleBtn` toggles the HTML log overlay (`#console`). That is **not** the engine console. The harness `client con` reads `Module.print` (engine) by default; `client con --stream html` is this overlay.

## Harness bridge (`?harness=1`)

Only for the agent CLI in [../test/AGENTS.md](../test/AGENTS.md). A normal visit without the query string must be unchanged.

The bridge composes `Module.print` / `printErr` into `window.__xon.con.engine`. It does **not** auto-click Play; `client play` does. `phase()` / `pick()` / `servers()` follow the HTML flow (settings → loading → browser → map download → match). `window.xonUi` on this page is the hook `pick` uses for `connectToServer`.

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
- Map texture prefetch → `map-assets.js`
- Headers, `/filelist`, `/dirlist`, MIME, caching, `/game/` fallback to `xonotic/data/` → `server.js`
- What gets downloaded into MEMFS → `xonotic/darkplaces/wasm/pre.js` then rebuild + copy JS here
- Do not point `--pre-js` at `web/pre.js` without reconciling it with `/filelist` + IDBFS + maps gamedir
- Do not drop COOP/COEP. Do not set `Access-Control-Allow-Origin: *` (Chrome rejects credentialed fetches against a wildcard; LAN `http://10.103…` hits this, `localhost` often does not)
- Do not flatten `/game/` or rename `*.pk3dir`

## Pitfalls

- Tests that skip `#playBtn` never load WASM.
- IDBFS (`IndexedDB` under the Chrome profile) is per origin **and per profile**. Two harness Chromes (`chrome-a` / `chrome-b`) each pay the full `/filelist` download unless the second profile is seeded.
- `web/pre.js` still describes on-demand fetch. The compiled pre.js downloads the **entire** `/filelist` up front. There is no live FS hook for missing files mid-game.
- `Module.downloadPack(url, filename)` is called from `connectToServer` → `downloadMapPk3` when no existing `.pk3` filename contains the map name. After a successful pack write the page already `em_exec fs_rescan`s before `connect`. Preloaded extras (`mint.pk3` in `/filelist`) skip this path.
- `web/map-assets.js` always runs on connect: parse the BSP texture lump, fetch matching `scripts/*.shader` plus the image/env files those shaders reference. Hits, in order: MEMFS, Cache Storage (`xon-postboot-v1`), then network (which also fills HTTP cache + Cache Storage + IDBFS). A map pk3 already in MEMFS still needs this — official maps reference trak/phillipk/sky packs that are not in the first-run `/filelist`.
- Joining another server mid-match must go through `connectToServer` (not a raw `em_exec connect`). That issues `disconnect` before the overlay, so the old dedicated is left instead of waiting for a timeout while the next map downloads.
- `/game/` serves `assets/game/` first, then falls back to `xonotic/data/` so those packs do not have to be copied into assets (and therefore not into the 2.8 GB boot download).
- Failed fetches in pre.js are marked downloaded and never retried until `assetVersion` changes or IDBFS is cleared. Map-asset 404s are not marked that way; the placeholder is the last resort.
- Linux paths are case-sensitive. Use `/404stats`.
- `localhost` in `connect` is rewritten in the engine to `127.0.0.1` (browser `gethostbyname` is useless). Other hostnames will fail; use dotted IPv4 from `/slist`.
