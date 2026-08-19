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

1. `GET /filelist` (every file under this directory)
2. Download all of them into MEMFS `/game/<path>` (skip if IDBFS cache version matches `Module.assetVersion`, currently `v2-full`)
3. There is **no** on-demand FS hook. If it is not in `/filelist` (or later `downloadPack`), the engine cannot open it

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

Native `sv_curl` map download does **not** work in WASM (libcurl is `dlopen`, no libcurl in the browser). Options:

1. Pre-seed the pk3 here so `/filelist` includes it
2. Call `Module.downloadPack(url, filename)` then `em_exec fs_rescan` (HTML does not do this yet)

### Extra untracked pk3s currently in this tree

`xonotic-maps.pk3dir/{4d_nex_driving_stunts_nolaser,The_DeaTHtemple,cts_wheresmucki,mint,pcp-nona,r7-prodigy,zastavka_eac1}.pk3` plus a leftover `assets/game/csprogs-xonotic-v0.8.6-*.pk3` at basedir root.

`/filelist` will ship **all** of them to every browser. Do not commit them. Treat `assets/game/` as a local cache, not source of truth. Extra maps belong in gitignore / object storage.

Also unused: `xonotic-music.pk3dir` is not synced (BGM silent unless you add `cdtracks.cfg` + oggs).

## Do not

- `rm -rf` this tree
- Flatten pk3dir folders or “dedupe” `.pk3` vs `.pk3dir`
- Re-encode `.tga` / `.ogg` / `.iqm`
- Put `qcsrc/`, `.git`, or `.map` sources in here (`/filelist` will serve them)
- Leave `csprogs-*.pk3` at `assets/game/` root (not a gamedir; engine will not mount it as CSQC)
- Commit multi-GB texture dumps or hashed map pk3s
