# Xonotic WASM Port

## Project Overview
This project ports the Xonotic first-person shooter game to WebAssembly (WASM) for browser-based play with multiplayer support via WebSocket networking.

## Directory Structure

```
xonweb/
├── emsdk/                    # Emscripten SDK installation
├── xonotic/                  # Xonotic source code (cloned via ./all)
│   ├── darkplaces/           # DarkPlaces engine (C) - modified for WASM
│   ├── data/xonotic-data.pk3dir/  # Gamecode (QuakeC) + game assets
│   ├── data/xonotic-maps.pk3dir/  # Map files
│   ├── gmqcc/                # QuakeC compiler
│   └── d0_blind_id/          # Crypto library
├── web/                      # Web frontend
│   ├── index.html            # Browser game shell
│   ├── server.js             # Static file server (port 9080)
│   ├── darkplaces-wasm.js    # Compiled WASM engine (single-file)
│   └── pre.js                # Asset loading/streaming (embedded in WASM build)
├── assets/                   # Game assets served to browser
│   └── game/                 # Game data directory structure
├── ws-proxy/                 # WebSocket-to-UDP proxy server
│   ├── server.js             # Proxy server (port 8081)
│   └── package.json
└── AGENTS.md                 # This file
```

## Build Instructions

### 1. Activate Emscripten
```bash
source /data/jake/reversing/xonweb/emsdk/emsdk_env.sh
```

### 2. Build the WASM Engine
```bash
cd xonotic/darkplaces
make emscripten-release
# Output: darkplaces-wasm.js (single-file, ~3.9MB)
```

### 3. Build QuakeC Gamecode
```bash
cd xonotic/gmqcc && make
cd ../data/xonotic-data.pk3dir && make
# Output: progs.dat, csprogs.dat, menu.dat
```

### 4. Copy Assets to Web Directory
```bash
# Copy essential files to assets/game/
cp xonotic/data/xonotic-data.pk3dir/{progs,csprogs,menu}.dat assets/game/
cp xonotic/data/xonotic-data.pk3dir/*.cfg assets/game/
```

### 5. Copy WASM to Web Directory
```bash
cp xonotic/darkplaces/darkplaces-wasm.js web/
```

## Running

### Start All Services
```bash
# Terminal 1: Asset/Web server
cd web && node server.js

# Terminal 2: WebSocket proxy
cd ws-proxy && node server.js

# Terminal 3: Xonotic dedicated server (for multiplayer testing)
cd xonotic/darkplaces && ./darkplaces-dedicated +sv_public 0 +port 26000

# Browser: Open http://localhost:9080/
```

### Connecting to a Multiplayer Server
1. Open the browser at http://localhost:9080/
2. Wait for assets to download and click "Click to Play"
3. Open console with backtick (`)
4. Type: `em_wss ws://localhost:8081 binary`
5. Type: `connect localhost:26000`

## Key Modifications to DarkPlaces

### glquake.h
- Added GL constant definitions for GLES2 mode (GL_BGRA, GL_PIXEL_PACK_BUFFER, etc.)
  that are referenced in shared code paths but not available in GLES2 headers

### gl_backend.c
- Guarded `GL_DebugOutputCallback` and debug output setup with `#ifndef USE_GLES2`
- Video capture (PBO-based) disabled for WASM builds (requires desktop GL features)

### snd_main.c
- Guarded `cls.capturevideo.active` reference with `#ifdef CONFIG_VIDEO_CAPTURE`

### makefile.inc
- WASM build targets use `-DCONFIG_MENU` only (no `CONFIG_VIDEO_CAPTURE`)
- Removed `$(OBJ_VIDEO_CAPTURE)` from `OBJ_WASM`
- Added `-lwebsocket.js` to WASM LDFLAGS

### lhnet.h
- Added `LHNETADDRESSTYPE_WEBSOCKET` to address type enum
- Added WebSocket transport fields to `lhnetsocket_t` (ws_handle, ws_connected, ws_peer, ws_proxy_url)

### lhnet.c
- Added WebSocket transport implementation using Emscripten WebSocket C API
- `LHNET_OpenSocket_Connectionless()`: WS case creates a lazy socket (connects on first write)
- `LHNET_Write()`: WS case opens WebSocket to proxy on first write, sends binary messages
- `LHNET_Read()`: WS case reads from receive queue (populated by async WebSocket callbacks)
- `LHNET_CloseSocket()`: WS case closes the WebSocket connection
- `LHNETADDRESS_FromPort()`: WS case creates a WEBSOCKET address
- Added `LHNET_SetWebSocketProxyURL()` / `LHNET_GetWebSocketProxyURL()` API

### netconn.c
- `NetConn_OpenClientPorts()`: Opens WEBSOCKET socket instead of INET4/INET6 for WASM
- `NetConn_ChooseClientSocketForAddress()`: Falls back to WS socket for INET4/INET6 addresses

### sys_wasm.c
- Fixed `em_wss` command to actually store the WebSocket proxy URL (was a stub)
- Made `em_wss` available in all WASM builds (was gated behind `WASM_USER_ADJUSTABLE`)
- Added forward declarations for `LHNET_SetWebSocketProxyURL` / `LHNET_GetWebSocketProxyURL`

### wasm/pre.js
- Replaced preload-all strategy with essential-files-first approach
- Downloads only gamecode, configs, and init map before starting engine
- Supports on-demand file fetching from asset server
