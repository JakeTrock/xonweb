const { chromium } = require('playwright');

(async () => {
    const browser = await chromium.launch({
        headless: true,
        args: ['--use-gl=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist', '--enable-webgl', '--webgl-force-enabled', '--autoplay-policy=no-user-gesture-required']
    });
    const context = await browser.newContext({ viewport: { width: 1280, height: 720 } });
    const page = await context.newPage();
    
    const shaderErrors = [];
    const allLogs = [];
    
    page.on('console', m => {
        const text = m.text();
        allLogs.push(text);
        if (text.toLowerCase().includes('shader') || text.toLowerCase().includes('glsl') || 
            text.toLowerCase().includes('compile') || text.toLowerCase().includes('error') ||
            text.toLowerCase().includes('fragment') || text.toLowerCase().includes('vertex') ||
            text.toLowerCase().includes('permutation') || text.toLowerCase().includes('lightgrid') ||
            text.toLowerCase().includes('lightdirectionmap')) {
            shaderErrors.push(text);
        }
    });
    page.on('pageerror', err => {
        shaderErrors.push('PAGEERROR: ' + err.message);
    });
    
    console.log('=== Loading page ===');
    await page.goto('http://localhost:9080/?t=' + Date.now(), { waitUntil: 'domcontentloaded', timeout: 30000 });
    
    // Wait for settings panel
    await page.waitForTimeout(2000);
    
    // Click Play
    console.log('=== Clicking Play ===');
    try { await page.click('#playBtn'); } catch(e) { console.log('No play button:', e.message); }
    
    // Wait for engine to start and compile shaders
    console.log('=== Waiting for shader compilation (30s) ===');
    for (let i = 0; i < 30; i++) {
        await page.waitForTimeout(2000);
        const elapsed = i * 2;
        const recentErrors = shaderErrors.filter((_, idx) => idx >= shaderErrors.length - 5);
        if (recentErrors.length > 0) {
            console.log(`[${elapsed}s] Recent shader-related logs:`, recentErrors.length);
        }
        // Check if we have menu loaded
        if (allLogs.some(l => l.includes('menu: program loaded'))) {
            console.log(`[${elapsed}s] Menu loaded, waiting a bit more for shader compilation...`);
            await page.waitForTimeout(5000);
            break;
        }
    }
    
    // Try to connect to the server to trigger more shader compilations
    console.log('=== Connecting to server to trigger shader compilation ===');
    try {
        await page.evaluate(() => Module.ccall('em_exec', null, ['string'], ['em_wss ws://localhost:8081 binary']));
        await page.waitForTimeout(500);
        await page.evaluate(() => Module.ccall('em_exec', null, ['string'], ['connect localhost:26000']));
    } catch(e) { console.log('exec error:', e.message); }
    
    // Wait for in-game shaders to compile
    console.log('=== Waiting for in-game shaders (20s) ===');
    await page.waitForTimeout(20000);
    
    // Print all shader-related errors
    console.log('\n========== SHADER-RELATED LOGS ==========');
    shaderErrors.forEach((err, i) => {
        console.log(`[${i}] ${err.substring(0, 500)}`);
    });
    
    // Also print any logs containing "failed" or "permutation"
    console.log('\n========== ALL LOGS WITH "fail" OR "permut" OR "shader" ==========');
    allLogs.filter(l => {
        const lower = l.toLowerCase();
        return lower.includes('fail') || lower.includes('permut') || lower.includes('shader') || 
               lower.includes('glsl') || lower.includes('compile') || lower.includes('error');
    }).forEach((err, i) => {
        console.log(`[${i}] ${err.substring(0, 500)}`);
    });
    
    // Print ALL logs to see what's happening
    console.log('\n========== ALL LOGS (last 100) ==========');
    allLogs.slice(-100).forEach((err, i) => {
        console.log(`[${i}] ${err.substring(0, 300)}`);
    });
    
    await page.screenshot({ path: '/data/jake/reversing/xonweb/test/screenshot-shader-test.png' });
    await browser.close();
    process.exit(0);
})();
