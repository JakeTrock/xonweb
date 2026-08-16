const { chromium } = require('playwright');

(async () => {
    const browser = await chromium.launch({
        headless: true,
        args: [
            '--use-gl=swiftshader',
            '--enable-unsafe-swiftshader',
            '--ignore-gpu-blocklist',
            '--enable-webgl',
            '--webgl-force-enabled',
        ]
    });
    
    const context = await browser.newContext({ viewport: { width: 1280, height: 720 } });
    const page = await context.newPage();
    
    const consoleMessages = [];
    page.on('console', msg => {
        consoleMessages.push({ type: msg.type(), text: msg.text(), time: Date.now() });
    });
    
    try {
        await page.goto('http://localhost:9080/', { waitUntil: 'domcontentloaded', timeout: 30000 });
        
        // Wait for engine + menu
        for (let i = 0; i < 60; i++) {
            await page.waitForTimeout(2000);
            if (consoleMessages.some(m => m.text.includes('menu: program loaded')) && i > 3) break;
        }
        await page.waitForTimeout(2000);
        console.log(`Engine ready.`);
        
        // Set WS proxy
        await page.evaluate(() => Module.ccall('em_exec', null, ['string'], ['em_wss ws://localhost:8081 binary\n']));
        await page.waitForTimeout(1000);
        console.log('WS proxy set.');
        
        // Connect
        console.log('Connecting to 127.0.0.1:26000...');
        const beforeConnect = consoleMessages.length;
        await page.evaluate(() => Module.ccall('em_exec', null, ['string'], ['connect 127.0.0.1:26000\n']));
        
        // Wait and collect ALL new messages
        for (let i = 0; i < 60; i++) {
            await page.waitForTimeout(2000);
            const newMsgs = consoleMessages.slice(beforeConnect);
            
            // Print only truly new messages
            if (newMsgs.length > 0 && i === 0) {
                console.log(`  Initial connect output:`);
                newMsgs.forEach(m => console.log(`    [${m.type}] ${m.text.substring(0, 200)}`));
            }
            
            // Check for specific messages
            const all = consoleMessages.slice(beforeConnect);
            const hasConnect = all.some(m => m.text.includes('Connect:'));
            const hasChallenge = all.some(m => m.text.includes('challenge') || m.text.includes('getchallenge'));
            const hasConnected = all.some(m => m.text.includes('Connected') || m.text.includes('connected'));
            const hasFailed = all.some(m => m.text.includes('failed') || m.text.includes('Could not'));
            const hasWS = all.some(m => m.text.includes('WebSocket') || m.text.includes('websocket'));
            
            if (i % 5 === 0) {
                console.log(`  ${i * 2}s: ${all.length} msgs, connect=${hasConnect}, challenge=${hasChallenge}, connected=${hasConnected}, failed=${hasFailed}, ws=${hasWS}`);
            }
            
            if (hasConnected || hasFailed) break;
        }
        
        // Print ALL messages after connect
        console.log('\n=== ALL messages after connect ===');
        consoleMessages.slice(beforeConnect).forEach(m => console.log(`[${m.type}] ${m.text.substring(0, 250)}`));
        
        // Check WS proxy logs
        const proxyResp = await page.evaluate(async () => {
            try {
                // Try to connect to the WS proxy to see if it's alive
                const ws = new WebSocket('ws://localhost:8081/?target=127.0.0.1:26000');
                return new Promise((resolve) => {
                    ws.onopen = () => { ws.close(); resolve('WS proxy reachable, connection opened'); };
                    ws.onerror = (e) => resolve('WS proxy error: ' + e.type);
                    ws.onclose = (e) => resolve('WS proxy closed: code=' + e.code);
                    setTimeout(() => resolve('WS proxy timeout'), 3000);
                });
            } catch(e) {
                return 'Error: ' + e.message;
            }
        });
        console.log('\nWS proxy test:', proxyResp);
        
        await page.screenshot({ path: '/data/jake/reversing/xonweb/test/screenshot-connect.png' });
        
    } catch (err) {
        console.error('Test failed:', err.message);
    }
    
    await browser.close();
    process.exit(0);
})();
