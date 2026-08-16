const { chromium } = require('playwright');

(async () => {
    const browser = await chromium.launch({
        headless: true,
        args: ['--use-gl=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist', '--enable-webgl', '--webgl-force-enabled']
    });
    const page = await (await browser.newContext({ viewport: { width: 1280, height: 720 } })).newPage();
    const msgs = [];
    page.on('console', m => msgs.push(m.text()));
    await page.goto('http://localhost:9080/?t=' + Date.now(), { waitUntil: 'domcontentloaded', timeout: 30000 });
    
    // Wait for engine + menu
    for (let i = 0; i < 30; i++) {
        await page.waitForTimeout(2000);
        if (msgs.some(m => m.includes('menu: program loaded')) && i > 3) break;
    }
    await page.waitForTimeout(2000);
    
    // Check for the two warnings
    const hasRAFWarn = msgs.some(m => m.includes('rendering without using requestAnimationFrame'));
    const hasMasterWarn = msgs.some(m => m.includes('Unable to query master servers'));
    
    console.log('requestAnimationFrame warning:', hasRAFWarn ? 'STILL PRESENT' : 'GONE');
    console.log('master servers warning:', hasMasterWarn ? 'STILL PRESENT' : 'GONE');
    
    // Test connect still works
    await page.evaluate(() => Module.ccall('em_exec', null, ['string'], ['em_wss ws://localhost:8081 binary\n']));
    await page.waitForTimeout(1000);
    
    const before = msgs.length;
    await page.evaluate(() => Module.ccall('em_exec', null, ['string'], ['connect 127.0.0.1:26000\n']));
    
    // Wait for connection
    for (let i = 0; i < 30; i++) {
        await page.waitForTimeout(2000);
        if (msgs.slice(before).some(m => m.includes('Connection established'))) {
            console.log('Multiplayer connection: WORKS');
            break;
        }
        if (msgs.slice(before).some(m => m.includes('failed') || m.includes('rejected'))) {
            console.log('Multiplayer connection: FAILED');
            break;
        }
    }
    
    // Print any remaining warnings/errors
    const warnings = msgs.filter(m => m.includes('warning') || m.includes('Warning') || m.includes('WARN'));
    console.log('\nRemaining warnings:', warnings.length);
    warnings.forEach(w => console.log('  ', w.substring(0, 150)));
    
    await page.screenshot({ path: '/data/jake/reversing/xonweb/test/screenshot-final.png' });
    await browser.close();
    process.exit(0);
})();
