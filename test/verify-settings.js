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
    await page.fill('#playerName', 'WasmPlayer');
    await page.selectOption('#playerModel', 'models/player/ignis.iqm');
    await page.click('#playBtn');
    
    for (let i = 0; i < 15; i++) {
        await page.waitForTimeout(2000);
        if (msgs.some(m => m.includes('menu: program loaded'))) break;
    }
    await page.waitForTimeout(2000);
    
    // Check if autoexec was executed
    const autoexecMsgs = msgs.filter(m => m.includes('autoexec'));
    console.log('Autoexec messages:', autoexecMsgs);
    
    // Read the autoexec.cfg from MEMFS to verify it was written
    const cfgContent = await page.evaluate(() => {
        try {
            var stat = FS.stat('/game/xonotic-data.pk3dir/autoexec.cfg');
            var stream = FS.open('/game/xonotic-data.pk3dir/autoexec.cfg', 'r');
            var buf = new Uint8Array(stat.size);
            FS.read(stream, buf, 0, stat.size, 0);
            FS.close(stream);
            return new TextDecoder().decode(buf);
        } catch(e) { return 'Error: ' + e.message; }
    });
    console.log('autoexec.cfg content:\n' + cfgContent);
    
    await browser.close();
    process.exit(0);
})();
