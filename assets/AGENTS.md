# assets/

HTTP tree served at `http://localhost:9080/game/`. This is the WASM `-basedir /game`, **not** the Xonotic source tree.

Parent: [../AGENTS.md](../AGENTS.md). Source data: [../xonotic/AGENTS.md](../xonotic/AGENTS.md). Gamecode build: [../xonotic/data/xonotic-data.pk3dir/AGENTS.md](../xonotic/data/xonotic-data.pk3dir/AGENTS.md).

## Layout (must keep these names)

```
assets/game/                            # Module -basedir /game
  xonotic-data.pk3dir/                  # -game #1 (progs, gfx, models, sound, cfgs)
  xonotic-maps.pk3dir/                  # -game #2 (map packs, map-only textures)
  font-xolonium.pk3dir/                 # sibling pack (font-xolonium.cfg + otf)
```

DarkPlaces treats `*.pk3dir` as a virtual pack (directory as zip) and also loads nested `*.pk3` inside it. Loose files in a gamedir override packs.

**Wrong:** `cp progs.dat assets/game/` — the engine will not see it.
**Right:** `cp progs.dat assets/game/xonotic-data.pk3dir/`

## What must exist to boot

| Path under `assets/game/` | Why |
|---|---|
| `xonotic-data.pk3dir/progs.dat` | SSQC |
| `xonotic-data.pk3dir/csprogs.dat` | CSQC |
| `xonotic-data.pk3dir/menu.dat` | Menu QC (still shipped; `forceqmenu 1` skips using it) |
| `xonotic-data.pk3dir/default.cfg` + exec chain (`xonotic-*.cfg`, `balance-xonotic.cfg`, binds, HUD cfgs) | Boot configs |
| `xonotic-data.pk3dir/maps/_init/_init.bsp` | Init map |
| `xonotic-data.pk3dir/gfx/` | HUD / menu / conchars. **Not** copied by `sync-assets.sh` |
| `font-xolonium.pk3dir/font-xolonium.cfg` + `fonts/*.otf` | UI font |

To actually play a map you also need that map’s **compiled BSP pack** (usually a hashed `.pk3` containing `maps/<name>.bsp`) plus map-specific textures/models/shaders.

Xoylent today: BSP is `xonotic-data.pk3dir/xoylent-<hash>-<hash>.pk3`; extras are under `xonotic-maps.pk3dir/` via `sync-assets.sh`. There is no loose `maps/xoylent.bsp`.

## How the browser gets these files

Compiled `xonotic/darkplaces/wasm/pre.js` (not `web/pre.js`):

1. `GET /filelist` (every file under this directory — **not** `xonotic/data/`)
2. Download all of them into MEMFS `/game/<path>` (skip if IDBFS cache version matches `Module.assetVersion`, currently `v2-full`)
3. There is **no** on-demand FS hook during a frame. Map textures **and BSP entity sounds** that are not in `/filelist` are fetched **on connect** by `web/map-assets.js` from `/game/` (this tree, then `xonotic/data/`) and cached in IDBFS. The checkerboard notexture is only used if that fetch 404s.

Failed HTTP fetches are marked downloaded and never retried until you bump `assetVersion` or clear IndexedDB.

## `sync-assets.sh`

Repo-root script. **xoylent-centric**, not a full maps mirror.

Copies from `xonotic/data/`:

- `xonotic-data.pk3dir/{textures,models,sound,scripts,particles,cubemaps}`
- xoylent extras from `xonotic-maps.pk3dir` (textures/exx, env/extragalactic, shaders, mapinfo)

Does **not** copy: `*.dat`, `*.cfg`, `gfx/`, fonts, `_init.bsp`, hashed map pk3s, music.

It currently hardcodes `/data/jake/reversing/xonweb/...`. Derive paths from the script location when you touch it.

After a QuakeC rebuild, always:

```bash
cp -f xonotic/data/xonotic-data.pk3dir/{progs,csprogs,menu}.dat \
      assets/game/xonotic-data.pk3dir/
```

Then bump `Module.assetVersion` in `xonotic/darkplaces/wasm/pre.js` or browsers keep stale `.dat` in IDBFS. Rebuild WASM only if you changed pre.js.

## Maps

Official compiled BSPs live as hashed zips next to the pk3dirs in `xonotic/data/`:

```
xonotic/data/<map>-<githash>-<contenthash>.pk3
```

`xonotic-maps.pk3dir/maps/` is mostly **source** (`.map`, `.mapinfo`, waypoints). Only `_init` has a BSP there.

To add a map for the web client:

```bash
cp -f xonotic/data/<map>-*.pk3 assets/game/xonotic-maps.pk3dir/
# plus any map-only textures if they are not already synced
```

That is **client-only**. `test/harness/stack` dedicated uses `-basedir xonotic`, so a pack that exists only here will load in the browser (`pick --map mint` logs `Map pk3 already in /game/xonotic-maps.pk3dir: mint.pk3`) and fail on the dedicated (`SpawnServer` never that map). Copy the other way for local 2p:

```bash
cp -f assets/game/xonotic-maps.pk3dir/mint.pk3 xonotic/data/mint.pk3
test/harness/stack start --map mint
```

WASM curl uses `GET /curlproxy?url=` (same-origin, COEP-safe) instead of dlopen libcurl. Successful GET bodies (and `/mapdl/` CDN packs) are stored on the web host under `.cache/assets/` for 3 days, keyed by origin host and optionally the dedicated `?server=` address — see [../web/AGENTS.md](../web/AGENTS.md). The dedicated can still `stuffcmd` `curl --pak --forthismap --as …`. Options if you want the pack before connect:

1. Pre-seed the pk3 here so `/filelist` includes it (`connectToServer` then skips `/mapdl/` when a `.pk3` **filename** contains the map name)
2. Call `Module.downloadPack(url, filename)` then `em_exec fs_rescan` (HTML `connectToServer` does this via `/mapdl/` when the pack is not already in MEMFS)
3. Official texture *sets* (trak6x, phillipk2x, skies, …) and map-pack sounds live in `xonotic/data/xonotic-maps.pk3dir/` and are **not** copied here. The web server serves them as `/game/` fallback; `map-assets.js` pulls the files the BSP’s shaders **and entity lump** name, then caches them. Do not rsync the whole 2.7 GB `textures/` tree into this directory just to avoid the checkerboard.

### Extra untracked pk3s currently in this tree

`xonotic-maps.pk3dir/{4d_nex_driving_stunts_nolaser,The_DeaTHtemple,cts_wheresmucki,mint,pcp-nona,r7-prodigy,zastavka_eac1}.pk3` plus a leftover `assets/game/csprogs-xonotic-v0.8.6-*.pk3` at basedir root.

`/filelist` will ship **all** of them to every browser (and to IDBFS). Do not commit them. Treat `assets/game/` as a local cache, not source of truth. Extra maps belong in gitignore / object storage. Filename vs BSP name can differ (`cts_wheresmucki.pk3` contains `maps/wheresmucki.bsp`); `pick --map` must be the BSP / dedicated map name, not the zip stem, unless they match (`mint`).

Also unused: `xonotic-music.pk3dir` is not synced (BGM silent unless you add `cdtracks.cfg` + oggs).

## Do not

- `rm -rf` this tree
- Flatten pk3dir folders or “dedupe” `.pk3` vs `.pk3dir`
- Re-encode `.tga` / `.ogg` / `.iqm`
- Put `qcsrc/`, `.git`, or `.map` sources in here (`/filelist` will serve them)
- Leave `csprogs-*.pk3` at `assets/game/` root (not a gamedir; engine will not mount it as CSQC)
- Commit multi-GB texture dumps or hashed map pk3s
