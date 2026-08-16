const { chromium } = require('playwright');

(async () => {
    const browser = await chromium.launch({
        headless: true,
        args: ['--use-gl=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist', '--enable-webgl', '--webgl-force-enabled']
    });
    const context = await browser.newContext({ viewport: { width: 1280, height: 720 } });
    const page = await context.newPage();
    
    const events = [];
    const startTime = Date.now();
    
    function log(type, text) {
        const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
        const entry = { t: elapsed, type, text: String(text).substring(0, 500) };
        events.push(entry);
        // Print key events live
        if (type === 'pageerror' ||
            text.includes('Downloaded') ||
            text.includes('Downloading') ||
            text.includes('Starting engine') ||
            text.includes('menu: program') ||
            text.includes('Connection established') ||
            text.includes('Cannot set') ||
            text.includes('emscripten_set_main_loop') ||
            text.includes('failed') ||
            text.includes('Error') ||
            text.includes('FATAL') ||
            text.includes('Aborted') ||
            text.includes('out of memory') ||
            text.includes('OOM') ||
            text.includes('Allocation') ||
            text.includes('Engine started') ||
            text.includes('Engine ready') ||
            text.includes('click-to-play') ||
            text.includes('Setup failed'))
        {
            console.log(`[${elapsed}s] ${type}: ${String(text).substring(0, 300)}`);
        }
    }
    
    page.on('console', m => log(m.type(), m.text()));
    page.on('pageerror', err => log('pageerror', err.message + '\n' + (err.stack || '')));
    page.on('requestfailed', req => log('requestfailed', req.url() + ' ' + (req.failure()?.errorText || '')));
    
    let completedRequests = 0;
    let totalBytes = 0;
    page.on('response', async resp => {
        completedRequests++;
        try {
            const cl = resp.headers()['content-length'];
            if (cl) totalBytes += parseInt(cl);
        } catch(e) {}
    });
    
    console.log('=== Navigating to page ===');
    await page.goto('http://localhost:9080/?t=' + Date.now(), { waitUntil: 'domcontentloaded', timeout: 30000 });
    
    let menuLoaded = false;
    let connectAttempted = false;
    let connectionEstablished = false;
    
    // Monitor for up to 90s
    for (let i = 0; i < 45; i++) {
        await page.waitForTimeout(2000);
        const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
        
        // Check if menu QC loaded
        if (!menuLoaded && events.some(e => e.text.includes('menu: program loaded'))) {
            menuLoaded = true;
            console.log(`\n=== MENU QC LOADED at ${elapsed}s ===\n`);
        }
        
        // After menu loads, wait a few seconds then try connecting
        if (menuLoaded && !connectAttempted && i > 2) {
            connectAttempted = true;
            console.log('=== Attempting multiplayer connect ===');
            try {
                await page.evaluate(() => Module.ccall('em_exec', null, ['string'], ['em_wss ws://localhost:8081 binary']));
                await page.waitForTimeout(500);
                await page.evaluate(() => Module.ccall('em_exec', null, ['string'], ['connect 127.0.0.1:26000']));
            } catch(e) {
                console.log('Connect error:', e.message);
            }
        }
        
        // Check for connection established
        if (!connectionEstablished && events.some(e => e.text.includes('Connection established'))) {
            connectionEstablished = true;
            console.log(`\n=== CONNECTION ESTABLISHED at ${elapsed}s ===\n`);
        }
        
        // If connection established, wait a bit more then we're done
        if (connectionEstablished && i > 3) {
            break;
        }
        
        // Check for fatal errors
        if (events.some(e => e.text.includes('Aborted') || e.text.includes('FATAL'))) {
            console.log(`\n=== FATAL ERROR at ${elapsed}s ===`);
            break;
        }
    }
    
    const totalElapsed = ((Date.now() - startTime) / 1000).toFixed(1);
    
    // Final report
    console.log('\n========== FINAL REPORT ==========');
    console.log(`Total time: ${totalElapsed}s`);
    console.log(`Menu QC loaded: ${menuLoaded}`);
    console.log(`Connection established: ${connectionEstablished}`);
    console.log(`Network: ${completedRequests} requests, ${(totalBytes/1024/1024).toFixed(1)}MB received`);
    console.log(`Total console events: ${events.length}`);
    
    // Check for emscripten errors
    const emErrors = events.filter(e => e.text.includes('emscripten') || e.text.includes('Cannot set'));
    console.log(`\nEmscripten errors: ${emErrors.length}`);
    emErrors.forEach(e => console.log(`  [${e.t}s] ${e.text.substring(0, 200)}`));
    
    // Check for page errors
    const pageErrors = events.filter(e => e.type === 'pageerror');
    console.log(`\nPage errors: ${pageErrors.length}`);
    pageErrors.forEach(e => console.log(`  [${e.t}s] ${e.text.substring(0, 300)}`));
    
    // Show timeline of key events
    console.log('\n--- Key event timeline ---');
    const keyEvents = events.filter(e => 
        e.text.includes('Downloading') || 
        e.text.includes('Downloaded') ||
        e.text.includes('Starting engine') ||
        e.text.includes('menu: program') ||
        e.text.includes('Connection established') ||
        e.text.includes('Engine started') ||
        e.text.includes('Cannot set') ||
        e.text.includes('emscripten') ||
        e.text.includes('Aborted') ||
        e.text.includes('Error') ||
        e.text.includes('failed')
    );
    keyEvents.forEach(e => console.log(`  [${e.t}s] ${e.type}: ${e.text.substring(0, 200)}`));
    
    // Show last 20 events
    console.log('\n--- Last 20 events ---');
    events.slice(-20).forEach(e => console.log(`  [${e.t}s] ${e.type}: ${e.text.substring(0, 200)}`));
    
    // Check if loading overlay is visible
    const overlayVisible = await page.evaluate(() => {
        const el = document.getElementById('loadingOverlay');
        if (!el) return 'not found';
        const style = window.getComputedStyle(el);
        return style.display !== 'none' && style.opacity !== '0' ? 'VISIBLE' : 'hidden';
    });
    console.log(`\nLoading overlay: ${overlayVisible}`);
    
    // Check if click-to-play is visible
    const ctpVisible = await page.evaluate(() => {
        const el = document.getElementById('clickToPlay');
        if (!el) return 'not found';
        const style = window.getComputedStyle(el);
        return style.display !== 'none' ? 'VISIBLE' : 'hidden';
    });
    console.log(`Click to play: ${ctpVisible}`);
    
    await page.screenshot({ path: '/data/jake/reversing/xonweb/test/screenshot-debug.png' });
    console.log('Screenshot saved');
    
    await browser.close();
    process.exit(0);
})();
