const { chromium } = require('playwright');
const { exec } = require('child_process');

(async () => {
    const browser = await chromium.launch({
        headless: true,
        args: ['--use-gl=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist', '--enable-webgl', '--webgl-force-enabled', '--autoplay-policy=no-user-gesture-required']
    });
    const context = await browser.newContext({ viewport: { width: 1280, height: 720 } });
    const page = await context.newPage();
    
    const events = [];
    const startTime = Date.now();
    
    // --- Comprehensive tracking ---
    const track = {
        // Audio
        audioInitStarted: false,
        audioDeviceOpened: false,
        audioDeviceFailed: false,
        audioWantedSpec: null,
        audioObtainedSpec: null,
        audioContextResumed: false,
        // Sounds
        soundsRequested: [],
        soundsOggLoading: [],
        soundsFailed: [],
        soundsLoaded: 0,
        // Textures / GL
        textureErrors: [],
        glErrors: [],
        lightgridStatus: null,
        sysErrors: [],
        hostErrors: [],
        // Assets
        fetchErrors: [],
        // Network
        wsOpens: 0,
        connectionEstablished: false,
        connectionFailed: false,
        // Page errors
        pageErrors: [],
    };
    
    // Categories for warning tracking (kept from original)
    const warnings = {
        missingModel: [],
        missingSound: [],
        missingTexture: [],
        notFound: [],
        fetchError: [],
        other: [],
    };
    
    function categorizeWarning(text) {
        const t = String(text).toLowerCase();
        if (t.includes('missing model') || t.includes('mod_loadmodel') || (t.includes('not found') && t.match(/\.(iqm|md3|dpm|zym|psk|obj)/i))) {
            warnings.missingModel.push(String(text).substring(0, 300));
        } else if (t.includes('missing sound') || t.includes('could not load sound') || t.includes('sfx_') || (t.includes('not found') && t.match(/\.(ogg|wav)/i))) {
            warnings.missingSound.push(String(text).substring(0, 300));
        } else if (t.includes('could not load texture') || (t.includes('not found') && t.match(/\.(tga|png|jpg|dds)/i))) {
            warnings.missingTexture.push(String(text).substring(0, 300));
        } else if (t.includes('fetch error') || t.includes('http 404') || t.includes('http 403')) {
            warnings.fetchError.push(String(text).substring(0, 300));
        } else if (t.includes('not found') || t.includes('could not') || t.includes('failed to') || t.includes('missing')) {
            warnings.notFound.push(String(text).substring(0, 300));
        } else if (t.includes('error') || t.includes('warn') || t.includes('failed')) {
            warnings.other.push(String(text).substring(0, 300));
        }
    }
    
    function log(type, text) {
        const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
        const str = String(text);
        const entry = { t: elapsed, type, text: str.substring(0, 500) };
        events.push(entry);
        
        // --- Parse for specific patterns ---
        const lower = str.toLowerCase();
        
        // Audio init
        if (lower.includes('sndsys_init') || lower.includes('sdl module')) track.audioInitStarted = true;
        if (lower.includes('wanted audio specification')) {
            track.audioWantedSpec = str.substring(0, 300);
            track.audioInitStarted = true;
        }
        if (lower.includes('obtained audio specification')) {
            track.audioObtainedSpec = str.substring(0, 300);
            track.audioDeviceOpened = true;
        }
        if (lower.includes('failed to open the audio device')) {
            track.audioDeviceFailed = true;
        }
        if (lower.includes('audiocontext resumed')) track.audioContextResumed = true;
        
        // Sound loading
        if (lower.includes('loading sound ')) {
            const match = str.match(/loading sound\s+(.+)/i);
            if (match) track.soundsRequested.push(match[1].trim().substring(0, 100));
        }
        if (lower.includes('loading ogg vorbis file')) {
            const match = str.match(/Loading Ogg Vorbis file\s+"([^"]+)"/i);
            if (match) track.soundsOggLoading.push(match[1]);
        }
        if (lower.includes('failed to load sound')) {
            const match = str.match(/Failed to load sound\s+"([^"]+)"/i);
            if (match) track.soundsFailed.push(match[1]);
            else track.soundsFailed.push(str.substring(0, 150));
        }
        
        // Texture / GL errors
        if (lower.includes('stretch uploads')) track.textureErrors.push(str.substring(0, 200));
        if (lower.includes('bogus texture size')) track.textureErrors.push(str.substring(0, 200));
        if (lower.includes('r_loadtexture') && lower.includes('unknown')) track.textureErrors.push(str.substring(0, 200));
        if (lower.includes('gl_invalid') || lower.includes('gl_error')) track.glErrors.push(str.substring(0, 200));
        if (lower.includes('lightgrid')) track.lightgridStatus = str.substring(0, 300);
        
        // Fatal errors
        if (lower.includes('sys_error') || lower.includes('sys error')) track.sysErrors.push(str.substring(0, 300));
        if (lower.includes('host_error') || lower.includes('host error')) track.hostErrors.push(str.substring(0, 300));
        
        // Fetch errors
        if (lower.includes('fetch error:') || lower.includes('http 404') || lower.includes('http 403')) {
            track.fetchErrors.push(str.substring(0, 200));
        }
        
        // Network
        if (lower.includes('opening websocket')) track.wsOpens++;
        if (lower.includes('connection established')) track.connectionEstablished = true;
        if (lower.includes('connect: failed')) track.connectionFailed = true;
        
        // Categorize warnings
        if (type === 'pageerror' || str.includes('Missing') || str.includes('missing') ||
            str.includes('not found') || str.includes('failed') ||
            str.includes('Could not') || str.includes('404')) {
            categorizeWarning(str);
        }
        
        // Always log important events
        if (type === 'pageerror' ||
            str.includes('Downloaded') || str.includes('Downloading') ||
            str.includes('[downloads]') ||
            str.includes('Starting engine') || str.includes('All files') ||
            str.includes('menu: program') || str.includes('Connection established') ||
            str.includes('Auto-navigated') || str.includes('Settings written') ||
            str.includes('Settings queued') || str.includes('IDBFS') ||
            str.includes('Cannot set') || str.includes('Opening WebSocket') ||
            str.includes('failed') || str.includes('Error') || str.includes('FATAL') ||
            str.includes('Aborted') || str.includes('Fetch error') ||
            str.includes('em_wss') || str.includes('querying') ||
            str.includes('Missing') || str.includes('missing') ||
            str.includes('Skipping') || str.includes('Persisting') ||
            str.includes('audio') || str.includes('Audio') ||
            str.includes('sound') || str.includes('Sound') ||
            str.includes('SndSys') || str.includes('ogg') || str.includes('Vorbis') ||
            str.includes('lightgrid') || str.includes('texture') ||
            str.includes('3D') || str.includes('developer') ||
            str.includes('Connect:'))
        {
            console.log(`[${elapsed}s] ${type}: ${str.substring(0, 300)}`);
        }
    }
    
    page.on('console', m => log(m.type(), m.text()));
    page.on('pageerror', err => { log('pageerror', err.message); track.pageErrors.push(err.message); });
    
    console.log('=== Navigating to page ===');
    await page.goto('http://localhost:9080/?t=' + Date.now(), { waitUntil: 'domcontentloaded', timeout: 30000 });
    
    // Verify settings panel is visible
    const settingsVisible = await page.evaluate(() => {
        const el = document.getElementById('settingsPanel');
        return el && !el.classList.contains('hidden');
    });
    console.log('Settings panel visible:', settingsVisible);
    
    // Change some settings via the HTML form
    await page.fill('#playerName', 'TestPlayer');
    await page.selectOption('#playerModel', 'models/player/ignis.iqm');
    await page.selectOption('#playerSkin', '1');
    
    // Click Play button
    console.log('=== Clicking Play ===');
    await page.click('#playBtn');
    
    // Wait for loading and engine start
    let menuLoaded = false;
    let autoNavDone = false;
    let downloadComplete = false;
    
    for (let i = 0; i < 90; i++) {
        await page.waitForTimeout(2000);
        const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
        
        if (!downloadComplete && events.some(e => e.text.includes('All files downloaded'))) {
            downloadComplete = true;
            console.log(`\n=== DOWNLOADS COMPLETE at ${elapsed}s ===\n`);
        }
        
        if (!menuLoaded && events.some(e => e.text.includes('menu: program loaded'))) {
            menuLoaded = true;
            console.log(`\n=== MENU QC LOADED at ${elapsed}s ===\n`);
        }
        
        if (!autoNavDone && events.some(e => e.text.includes('Auto-navigated'))) {
            autoNavDone = true;
            console.log(`=== AUTO-NAVIGATED to servers tab at ${elapsed}s ===`);
        }
        
        if (menuLoaded && autoNavDone && downloadComplete && i > 2) break;
    }
    
    // Check UI state
    const overlayHidden = await page.evaluate(() => document.getElementById('loadingOverlay').classList.contains('hidden'));
    const toolbarVisible = await page.evaluate(() => document.getElementById('toolbar').style.display === 'flex');
    console.log('Loading overlay hidden:', overlayHidden);
    console.log('Toolbar visible:', toolbarVisible);
    
    const settingsWritten = events.some(e => e.text.includes('Settings written'));
    console.log('Settings written to MEMFS:', settingsWritten);
    
    // --- Enable verbose sound loading ---
    console.log('\n=== Enabling developer_loading 2 for verbose sound logging ===');
    try {
        await page.evaluate(() => Module.ccall('em_exec', null, ['string'], ['developer_loading 2']));
    } catch(e) { console.log('em_exec error:', e.message); }
    await page.waitForTimeout(500);
    
    // Wait for server list to populate
    console.log('\n=== Waiting for server list ===');
    for (let i = 0; i < 8; i++) {
        await page.waitForTimeout(2000);
        if (track.wsOpens > 0) {
            console.log(`WebSocket opens: ${track.wsOpens}`);
        }
        if (i >= 3) break;
    }
    
    // Take screenshot of server list
    await page.screenshot({ path: '/data/jake/reversing/xonweb/test/screenshot-serverlist.png' });
    console.log('Server list screenshot saved');
    
    // --- Test UDP connect ---
    console.log('\n=== Testing UDP connect ===');
    try {
        await page.evaluate(() => Module.ccall('em_exec', null, ['string'], ['em_wss ws://localhost:8081 binary']));
        await page.waitForTimeout(500);
        await page.evaluate(() => Module.ccall('em_exec', null, ['string'], ['connect localhost:26000']));
    } catch(e) { console.log('em_exec error:', e.message); }
    
    let udpConnected = false;
    for (let i = 0; i < 20; i++) {
        await page.waitForTimeout(2000);
        if (track.connectionEstablished) {
            udpConnected = true;
            track.connectionEstablished = false; // reset for TCP test
            console.log(`UDP Connection established at ${((Date.now() - startTime) / 1000).toFixed(1)}s`);
            break;
        }
        if (track.connectionFailed) {
            console.log('UDP Connection failed');
            track.connectionFailed = false;
            break;
        }
    }
    
    // --- If connected, stay in-game and run diagnostics ---
    if (udpConnected) {
        console.log('\n=== In-game diagnostics (20s) ===');
        
        // Wait 5s for map to load, then start diagnostics
        await page.waitForTimeout(5000);
        await page.screenshot({ path: '/data/jake/reversing/xonweb/test/screenshot-ingame-5s.png' });
        console.log('In-game screenshot (5s) saved');
        
        // Query cvar values — the output appears in console.log which we capture
        console.log('\n--- Querying engine state ---');
        const cvars = [
            'snd_initialized', 'volume', 'snd_speed', 'snd_width', 'snd_channels',
            'bgmvolume', 'snd_bufferlength',
            'r_shadow_bouncegrid',
            'mod_q3bsp_lightgrid_texture',
        ];
        for (const cv of cvars) {
            try {
                await page.evaluate((c) => Module.ccall('em_exec', null, ['string'], [c]), cv);
                await page.waitForTimeout(200);
            } catch(e) {}
        }
        
        // Play test sounds to trigger sound loading
        console.log('\n--- Playing test sounds ---');
        const testSounds = [
            'sound/misc/menu1.wav',
            'sound/misc/menu2.wav',
            'sound/misc/menu3.wav',
            'sound/misc/armor1.ogg',
            'sound/misc/armor2.ogg',
            'sound/misc/footstep01.ogg',
            'sound/misc/footstep02.ogg',
            'sound/weapons/hagar_fire.ogg',
            'sound/player/loenzignis/jump.ogg',
        ];
        for (const snd of testSounds) {
            try {
                await page.evaluate((s) => Module.ccall('em_exec', null, ['string'], ['play ' + s]), snd);
                await page.waitForTimeout(300);
            } catch(e) {}
        }
        
        // Wait 5 more seconds
        await page.waitForTimeout(5000);
        await page.screenshot({ path: '/data/jake/reversing/xonweb/test/screenshot-ingame-10s.png' });
        console.log('In-game screenshot (10s) saved');
        
        // Query cvars again (some may have changed after map load)
        console.log('\n--- Post-load cvar query ---');
        for (const cv of cvars) {
            try {
                await page.evaluate((c) => Module.ccall('em_exec', null, ['string'], [c]), cv);
                await page.waitForTimeout(200);
            } catch(e) {}
        }
        
        // Play more sounds (game sounds that should now be precached)
        console.log('\n--- Playing more test sounds ---');
        const moreSounds = [
            'sound/misc/base.ogg',
            'sound/world/water1.wav',
            'sound/weapons/electro_fire.ogg',
            'sound/weapons/mortar_fire.ogg',
            'sound/weapons/ric1.wav',
            'sound/weapons/ric2.wav',
            'sound/weapons/ric3.wav',
        ];
        for (const snd of moreSounds) {
            try {
                await page.evaluate((s) => Module.ccall('em_exec', null, ['string'], ['play ' + s]), snd);
                await page.waitForTimeout(300);
            } catch(e) {}
        }
        
        // Wait 5 more seconds
        await page.waitForTimeout(5000);
        await page.screenshot({ path: '/data/jake/reversing/xonweb/test/screenshot-ingame-15s.png' });
        console.log('In-game screenshot (15s) saved');
        
        // Disconnect
        try { await page.evaluate(() => Module.ccall('em_exec', null, ['string'], ['disconnect'])); } catch(e) {}
        await page.waitForTimeout(2000);
    }
    
    // --- Test TCP bridge ---
    console.log('\n=== Testing TCP bridge ===');
    const relayProc = exec('node /data/jake/reversing/xonweb/ws-proxy/tcp-relay.js --listen 127.0.0.1:9260 --target 127.0.0.1:26000');
    await new Promise(r => setTimeout(r, 1500));
    
    try {
        await page.evaluate(() => Module.ccall('em_exec', null, ['string'], ['em_wss ws://localhost:8081?proto=tcp binary']));
        await page.waitForTimeout(500);
        await page.evaluate(() => Module.ccall('em_exec', null, ['string'], ['connect localhost:9260']));
    } catch(e) { console.log('em_exec error:', e.message); }
    
    const tcpStartTime = events.length;
    let tcpConnected = false;
    for (let i = 0; i < 20; i++) {
        await page.waitForTimeout(2000);
        const newEvents = events.slice(tcpStartTime);
        if (newEvents.some(e => e.text.includes('Connection established'))) {
            tcpConnected = true;
            console.log(`TCP Connection established at ${((Date.now() - startTime) / 1000).toFixed(1)}s`);
            break;
        }
        if (newEvents.some(e => e.text.includes('Connect: failed'))) {
            console.log('TCP Connection failed');
            break;
        }
    }
    
    relayProc.kill();
    
    // --- Query AudioContext state from JS ---
    let audioContextState = 'unknown';
    try {
        audioContextState = await page.evaluate(() => {
            if (typeof SDL2 !== 'undefined' && SDL2.audioContext) {
                return SDL2.audioContext.state;
            }
            return 'no SDL2.audioContext';
        });
    } catch(e) {}
    console.log('AudioContext state:', audioContextState);
    
    // --- Fetch 404 stats from server ---
    let notFound404s = [];
    try {
        const resp = await page.evaluate(async () => {
            const r = await fetch('/404stats');
            return await r.json();
        });
        notFound404s = resp.paths || [];
    } catch(e) { console.log('Failed to fetch 404 stats:', e.message); }
    
    // --- Pixel analysis of screenshots ---
    const { execSync } = require('child_process');
    function analyzeScreenshot(path) {
        try {
            const result = execSync(`python3 -c "
from PIL import Image
img = Image.open('${path}')
colors = img.getcolors(maxcolors=200000)
total = sum(c for c, _ in colors) if colors else 0
non_black = sum(c for c, color in colors if any(v > 10 for v in color[:3])) if colors else 0
unique = len(colors) if colors else 0
# Sample center region
w, h = img.size
center_nonblack = 0
center_total = 0
for y in range(h//4, 3*h//4, 4):
    for x in range(w//4, 3*w//4, 4):
        p = img.getpixel((x, y))
        center_total += 1
        if any(c > 10 for c in p[:3]):
            center_nonblack += 1
print(f'non_black={non_black} total={total} unique={unique} center_nonblack={center_nonblack} center_total={center_total}')
" 2>/dev/null`).toString().trim();
            return result;
        } catch(e) { return 'analysis failed'; }
    }
    
    // --- Parse cvar values from console output ---
    const cvarValues = {};
    const cvarPattern = /"([^"]+)"\s+is\s+"([^"]*)"/;
    for (const e of events) {
        const m = e.text.match(cvarPattern);
        if (m) cvarValues[m[1]] = m[2];
    }
    
    // --- Count sound loading results ---
    const oggLoaded = track.soundsOggLoading.length;
    const soundsFailedUnique = [...new Set(track.soundsFailed)];
    
    // --- Final Report ---
    const totalElapsed = ((Date.now() - startTime) / 1000).toFixed(1);
    console.log('\n========== FINAL REPORT ==========');
    console.log(`Total time: ${totalElapsed}s`);
    console.log(`Settings panel visible: ${settingsVisible}`);
    console.log(`Settings written to MEMFS: ${settingsWritten}`);
    console.log(`Downloads complete: ${downloadComplete}`);
    console.log(`Menu QC loaded: ${menuLoaded}`);
    console.log(`Auto-navigated to servers: ${autoNavDone}`);
    console.log(`UDP connection: ${udpConnected ? 'OK' : 'FAILED'}`);
    console.log(`TCP connection: ${tcpConnected ? 'OK' : 'FAILED'}`);
    
    // --- Audio Section ---
    console.log('\n--- AUDIO ---');
    console.log(`Audio init started: ${track.audioInitStarted}`);
    console.log(`Audio device opened: ${track.audioDeviceOpened}`);
    console.log(`Audio device failed: ${track.audioDeviceFailed}`);
    console.log(`AudioContext resumed: ${track.audioContextResumed}`);
    console.log(`AudioContext state: ${audioContextState}`);
    if (track.audioWantedSpec) console.log(`Wanted spec: ${track.audioWantedSpec}`);
    if (track.audioObtainedSpec) console.log(`Obtained spec: ${track.audioObtainedSpec}`);
    console.log(`snd_initialized: ${cvarValues['snd_initialized'] || 'not queried'}`);
    console.log(`volume: ${cvarValues['volume'] || 'not queried'}`);
    console.log(`snd_speed: ${cvarValues['snd_speed'] || 'not queried'}`);
    console.log(`snd_width: ${cvarValues['snd_width'] || 'not queried'}`);
    console.log(`snd_channels: ${cvarValues['snd_channels'] || 'not queried'}`);
    console.log(`bgmvolume: ${cvarValues['bgmvolume'] || 'not queried'}`);
    
    // --- Sound Loading Section ---
    console.log('\n--- SOUND LOADING ---');
    console.log(`Sounds requested (developer_loading): ${track.soundsRequested.length}`);
    console.log(`OGG files loading attempted: ${oggLoaded}`);
    console.log(`Sounds failed to load: ${soundsFailedUnique.length}`);
    if (soundsFailedUnique.length > 0) {
        console.log('  Failed sounds (unique):');
        soundsFailedUnique.slice(0, 30).forEach(s => console.log(`    ${s}`));
        if (soundsFailedUnique.length > 30) console.log(`    ... and ${soundsFailedUnique.length - 30} more`);
    }
    if (track.soundsRequested.length > 0 && oggLoaded === 0 && soundsFailedUnique.length === 0) {
        console.log('  WARNING: No sound loading activity detected — developer_loading may not have taken effect');
    }
    if (oggLoaded > 0 && soundsFailedUnique.length === 0) {
        console.log('  OK: OGG sounds are loading successfully');
    }
    if (oggLoaded === 0 && soundsFailedUnique.length > 0) {
        console.log('  CRITICAL: OGG sounds failing — Vorbis library may not be linked');
    }
    
    // --- Textures / 3D Section ---
    console.log('\n--- TEXTURES / 3D ---');
    console.log(`Texture errors: ${track.textureErrors.length}`);
    if (track.textureErrors.length > 0) {
        track.textureErrors.forEach(e => console.log(`  ${e}`));
    }
    console.log(`GL errors: ${track.glErrors.length}`);
    console.log(`Lightgrid status: ${track.lightgridStatus || 'not mentioned'}`);
    console.log(`Sys errors: ${track.sysErrors.length}`);
    if (track.sysErrors.length > 0) track.sysErrors.forEach(e => console.log(`  ${e}`));
    console.log(`Host errors: ${track.hostErrors.length}`);
    if (track.hostErrors.length > 0) track.hostErrors.forEach(e => console.log(`  ${e}`));
    console.log(`mod_q3bsp_lightgrid_texture: ${cvarValues['mod_q3bsp_lightgrid_texture'] || 'not queried'}`);
    console.log(`r_shadow_bouncegrid: ${cvarValues['r_shadow_bouncegrid'] || 'not queried'}`);
    
    // --- Warning Summary ---
    console.log('\n--- Warning Summary ---');
    console.log(`Missing models: ${warnings.missingModel.length}`);
    console.log(`Missing sounds: ${warnings.missingSound.length}`);
    console.log(`Missing textures: ${warnings.missingTexture.length}`);
    console.log(`Fetch errors: ${warnings.fetchError.length}`);
    console.log(`Other not-found: ${warnings.notFound.length}`);
    console.log(`Other warnings: ${warnings.other.length}`);
    
    // Print unique missing files
    if (warnings.missingModel.length > 0) {
        console.log('\n--- Missing Models (unique) ---');
        const unique = [...new Set(warnings.missingModel.map(s => s.match(/[\w\/\.]+\.(iqm|md3|dpm|zym|psk|obj)/gi)?.[0] || s.substring(0, 100)))];
        unique.forEach(f => console.log(`  ${f}`));
    }
    if (warnings.missingSound.length > 0) {
        console.log('\n--- Missing Sounds (unique) ---');
        const unique = [...new Set(warnings.missingSound.map(s => s.match(/[\w\/\.]+\.(ogg|wav)/gi)?.[0] || s.substring(0, 100)))];
        unique.forEach(f => console.log(`  ${f}`));
    }
    if (warnings.missingTexture.length > 0) {
        console.log('\n--- Missing Textures (unique) ---');
        const unique = [...new Set(warnings.missingTexture.map(s => s.match(/[\w\/\.]+\.(tga|png|jpg|dds)/gi)?.[0] || s.substring(0, 100)))];
        unique.forEach(f => console.log(`  ${f}`));
    }
    
    // --- Server 404s ---
    if (notFound404s.length > 0) {
        console.log(`\n--- Server 404s (${notFound404s.length} unique paths) ---`);
        notFound404s.slice(0, 50).forEach(p => console.log(`  ${p}`));
        if (notFound404s.length > 50) console.log(`  ... and ${notFound404s.length - 50} more`);
    } else {
        console.log('\n--- Server 404s: None ---');
    }
    
    // --- Page Errors ---
    console.log(`\nPage errors: ${track.pageErrors.length}`);
    track.pageErrors.forEach(e => console.log(`  ${e.substring(0, 200)}`));
    
    // --- Screenshot Analysis ---
    console.log('\n--- Screenshot Analysis ---');
    const screenshots = [
        'screenshot-serverlist.png',
        'screenshot-ingame-5s.png',
        'screenshot-ingame-10s.png',
        'screenshot-ingame-15s.png',
    ];
    for (const ss of screenshots) {
        const path = `/data/jake/reversing/xonweb/test/${ss}`;
        try {
            const fs = require('fs');
            if (fs.existsSync(path)) {
                const analysis = analyzeScreenshot(path);
                console.log(`  ${ss}: ${analysis}`);
            }
        } catch(e) { console.log(`  ${ss}: analysis failed`); }
    }
    
    // --- Key events timeline ---
    console.log('\n--- Key events ---');
    events.filter(e => 
        e.text.includes('Settings') || e.text.includes('[downloads]') || 
        e.text.includes('Downloaded') || e.text.includes('All files') ||
        e.text.includes('Starting engine') || e.text.includes('menu: program') ||
        e.text.includes('Auto-navigated') || e.text.includes('Connection established') ||
        e.text.includes('Connect: failed') || e.text.includes('Opening WebSocket') ||
        e.text.includes('IDBFS') || e.text.includes('em_wss') ||
        e.text.includes('Skipping') || e.text.includes('Persisting') ||
        e.text.includes('Fetch error') || e.text.includes('Missing') ||
        e.text.includes('audio') || e.text.includes('Audio') ||
        e.text.includes('SndSys') || e.text.includes('sound') ||
        e.text.includes('lightgrid') || e.text.includes('Vorbis') ||
        e.text.includes('is "')) // cvar printouts
    .forEach(e => console.log(`  [${e.t}s] ${e.text.substring(0, 200)}`));
    
    await page.screenshot({ path: '/data/jake/reversing/xonweb/test/screenshot-final.png' });
    await browser.close();
    process.exit(0);
})();
