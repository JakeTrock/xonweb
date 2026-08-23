'use strict';

const dgram = require('dgram');
const WebSocket = require('ws');

const GETINFO = Buffer.concat([Buffer.from([0xff, 0xff, 0xff, 0xff]), Buffer.from('getinfo')]);
const INFO_PREFIX = Buffer.concat([Buffer.from([0xff, 0xff, 0xff, 0xff]), Buffer.from('infoResponse\n')]);

function parseHostPort(addr, defaultPort) {
	if (!addr) return { host: '127.0.0.1', port: defaultPort || 26000 };
	const s = String(addr).trim();
	const idx = s.lastIndexOf(':');
	if (idx <= 0) return { host: s, port: defaultPort || 26000 };
	const port = parseInt(s.slice(idx + 1), 10);
	return { host: s.slice(0, idx), port: isNaN(port) ? (defaultPort || 26000) : port };
}

function summarize(samples) {
	const s = (samples || []).filter((x) => typeof x === 'number' && isFinite(x)).slice().sort((a, b) => a - b);
	if (!s.length) return null;
	const n = s.length;
	const sum = s.reduce((a, b) => a + b, 0);
	const mean = sum / n;
	const at = (q) => s[Math.min(n - 1, Math.max(0, Math.floor(q * (n - 1))))];
	let varsum = 0;
	for (const x of s) varsum += (x - mean) * (x - mean);
	return {
		n,
		min: s[0],
		max: s[n - 1],
		mean: Math.round(mean * 100) / 100,
		stdev: Math.round(Math.sqrt(varsum / n) * 100) / 100,
		p50: at(0.5),
		p95: at(0.95),
		p99: at(0.99),
	};
}

function isInfoResponse(msg) {
	return Buffer.isBuffer(msg) && msg.length >= INFO_PREFIX.length && msg.slice(0, INFO_PREFIX.length).equals(INFO_PREFIX);
}

function probeDirectUdp(host, port, opts) {
	const count = opts.count || 30;
	const timeoutMs = opts.timeoutMs || 1500;
	const gapMs = opts.gapMs == null ? 40 : opts.gapMs;
	return new Promise((resolve) => {
		const sock = dgram.createSocket('udp4');
		const rtts = [];
		let sent = 0;
		let lost = 0;
		let inFlight = false;
		let sendAt = 0;
		let timer = null;
		let done = false;

		const finish = () => {
			if (done) return;
			done = true;
			clearTimeout(timer);
			try { sock.close(); } catch (e) { /* ignore */ }
			resolve({
				path: 'udp-direct',
				host,
				port,
				sent,
				received: rtts.length,
				lost,
				lossPct: sent ? Math.round((lost / sent) * 1000) / 10 : 0,
				rttMs: summarize(rtts),
				samples: rtts,
			});
		};

		const sendNext = () => {
			if (sent >= count) return finish();
			inFlight = true;
			sent++;
			sendAt = Date.now();
			try { sock.send(GETINFO, port, host); } catch (e) {
				lost++;
				inFlight = false;
				return setTimeout(sendNext, gapMs);
			}
			timer = setTimeout(() => {
				if (!inFlight) return;
				inFlight = false;
				lost++;
				setTimeout(sendNext, gapMs);
			}, timeoutMs);
		};

		sock.on('message', (msg) => {
			if (!inFlight || !isInfoResponse(msg)) return;
			inFlight = false;
			clearTimeout(timer);
			rtts.push(Date.now() - sendAt);
			setTimeout(sendNext, gapMs);
		});
		sock.on('error', () => { /* counted as timeout */ });
		sock.bind(0, () => sendNext());
	});
}

function probeViaProxy(proxyUrl, host, port, opts) {
	const count = opts.count || 30;
	const timeoutMs = opts.timeoutMs || 1500;
	const gapMs = opts.gapMs == null ? 40 : opts.gapMs;
	let wsUrl = proxyUrl.replace(/\/+$/, '') + '/?target=' + encodeURIComponent(host + ':' + port);
	if (opts.proto) wsUrl += '&proto=' + encodeURIComponent(opts.proto);
	return new Promise((resolve) => {
		const rtts = [];
		let sent = 0;
		let lost = 0;
		let inFlight = false;
		let sendAt = 0;
		let timer = null;
		let pingTimer = null;
		let done = false;
		const wsRtts = [];
		let lastPingAt = 0;
		let openMs = null;
		const openedAt = Date.now();

		const finish = (error) => {
			if (done) return;
			done = true;
			clearTimeout(timer);
			if (pingTimer) clearInterval(pingTimer);
			try { ws.close(); } catch (e) { /* ignore */ }
			resolve({
				path: 'ws-proxy',
				proxyUrl,
				wsUrl,
				host,
				port,
				openMs,
				error: error || undefined,
				sent,
				received: rtts.length,
				lost,
				lossPct: sent ? Math.round((lost / sent) * 1000) / 10 : 0,
				rttMs: summarize(rtts),
				wsPingMs: summarize(wsRtts),
				samples: rtts,
			});
		};

		const ws = new WebSocket(wsUrl, ['binary'], {
			perMessageDeflate: false,
			skipUTF8Validation: true,
		});

		const sendNext = () => {
			if (done) return;
			if (sent >= count) return finish();
			if (ws.readyState !== WebSocket.OPEN) return finish('websocket closed');
			inFlight = true;
			sent++;
			sendAt = Date.now();
			try { ws.send(GETINFO, { binary: true, compress: false }); } catch (e) {
				lost++;
				inFlight = false;
				return setTimeout(sendNext, gapMs);
			}
			timer = setTimeout(() => {
				if (!inFlight) return;
				inFlight = false;
				lost++;
				setTimeout(sendNext, gapMs);
			}, timeoutMs);
		};

		ws.on('open', () => {
			openMs = Date.now() - openedAt;
			if (ws._socket) {
				try { ws._socket.setNoDelay(true); } catch (e) { /* ignore */ }
			}
			pingTimer = setInterval(() => {
				if (ws.readyState !== WebSocket.OPEN) return;
				lastPingAt = Date.now();
				try { ws.ping(); } catch (e) { /* ignore */ }
			}, 1000);
			sendNext();
		});
		ws.on('pong', () => {
			if (lastPingAt) wsRtts.push(Date.now() - lastPingAt);
		});
		ws.on('message', (data, isBinary) => {
			if (isBinary === false) return;
			const msg = Buffer.isBuffer(data) ? data : Buffer.from(data);
			if (!inFlight || !isInfoResponse(msg)) return;
			inFlight = false;
			clearTimeout(timer);
			rtts.push(Date.now() - sendAt);
			setTimeout(sendNext, gapMs);
		});
		ws.on('error', (err) => finish(err.message));
		ws.on('close', () => {
			if (!done && sent === 0) finish('websocket closed before first probe');
		});
		setTimeout(() => {
			if (!done && sent === 0) finish('websocket open timeout');
		}, 4000);
	});
}

function judgeBridge(direct, viaProxy) {
	const reasons = [];
	const warnings = [];
	const d = direct && direct.rttMs;
	const p = viaProxy && viaProxy.rttMs;
	if (viaProxy && viaProxy.error) reasons.push('proxy probe failed: ' + viaProxy.error);
	if (viaProxy) {
		const extraLoss = viaProxy.lossPct - (direct ? direct.lossPct : 0);
		if (viaProxy.lossPct > 5 && extraLoss > 5)
			reasons.push('proxy getinfo loss ' + viaProxy.lossPct + '% (' + (extraLoss > 0 ? '+' : '') + extraLoss + ' vs direct)');
		else if (!direct && viaProxy.lossPct > 5)
			reasons.push('proxy getinfo loss ' + viaProxy.lossPct + '%');
	}
	if (direct && direct.lossPct > 20) warnings.push('direct UDP loss ' + direct.lossPct + '% (target may be far or filtered)');
	if (d && p) {
		const overhead = p.p50 - d.p50;
		if (overhead > 15) reasons.push('proxy adds ' + Math.round(overhead) + 'ms median vs direct UDP (p50 proxy ' + p.p50 + ' direct ' + d.p50 + ')');
		if (p.p95 - d.p95 > 30) reasons.push('proxy p95 is ' + Math.round(p.p95 - d.p95) + 'ms worse than direct');
		if (p.stdev > 15 && d.stdev < 8) reasons.push('proxy jitter stdev ' + p.stdev + 'ms vs direct ' + d.stdev + 'ms');
	} else if (p && p.p95 > 80) {
		warnings.push('proxy p95 RTT ' + p.p95 + 'ms (no direct baseline)');
	}
	if (viaProxy && viaProxy.wsPingMs && viaProxy.wsPingMs.p95 > 20)
		reasons.push('local WebSocket ping p95 ' + viaProxy.wsPingMs.p95 + 'ms (should be ~0-2ms on loopback)');
	if (viaProxy && viaProxy.openMs != null && viaProxy.openMs > 500)
		warnings.push('websocket handshake ' + viaProxy.openMs + 'ms');
	return {
		deficient: reasons.length > 0,
		reasons,
		warnings,
		overheadMs: d && p ? Math.round((p.p50 - d.p50) * 10) / 10 : null,
	};
}

function originDelta(a, b) {
	if (!a || !b || a.length < 3 || b.length < 3) return null;
	const dx = a[0] - b[0], dy = a[1] - b[1], dz = a[2] - b[2];
	return Math.sqrt(dx * dx + dy * dy + dz * dz);
}

function judgeClient(samples, proxyStats) {
	const reasons = [];
	const warnings = [];
	const connected = samples.filter((s) => s && s.connected && (s.signon >= (s.signons || 4) || s.signon >= 4));
	if (!samples.length) {
		reasons.push('no state samples');
		return { deficient: true, reasons, warnings, n: 0, connected: 0 };
	}
	if (!connected.length) {
		reasons.push('client never reached match (connected+signon); netprobe needs an in-game session');
		return { deficient: true, reasons, warnings, n: samples.length, connected: 0 };
	}

	const pings = connected.map((s) => s.ping).filter((x) => typeof x === 'number' && x > 0);
	const loss = connected.map((s) => s.packetloss).filter((x) => typeof x === 'number');
	const since = connected.map((s) => s.sinceLastMessage).filter((x) => typeof x === 'number' && x >= 0);
	const fps = connected.map((s) => s.fps).filter((x) => typeof x === 'number' && x > 0);
	const recv = connected.map((s) => s.packetsReceived).filter((x) => typeof x === 'number');
	const mtime = connected.map((s) => s.mtime).filter((x) => typeof x === 'number');

	const pingSum = summarize(pings);
	const lossSum = summarize(loss);
	const sinceSum = summarize(since);
	const fpsSum = summarize(fps);

	if (lossSum && lossSum.max > 10) reasons.push('engine packetloss peaked at ' + lossSum.max + '%');
	if (sinceSum && sinceSum.max > 0.5) reasons.push('gap since last net message ' + sinceSum.max.toFixed(3) + 's');
	if (recv.length >= 2 && recv[recv.length - 1] <= recv[0])
		reasons.push('packetsReceived did not increase (' + recv[0] + ' → ' + recv[recv.length - 1] + ')');
	if (mtime.length >= 2 && mtime[mtime.length - 1] <= mtime[0] + 0.05)
		reasons.push('server mtime did not advance (stalled snapshots)');
	if (pingSum && pingSum.p50 >= 250) reasons.push('engine ping p50 ' + pingSum.p50 + 'ms');

	let teleports = 0;
	for (let i = 1; i < connected.length; i++) {
		const dt = (connected[i].realtime || 0) - (connected[i - 1].realtime || 0);
		const d = originDelta(connected[i].origin, connected[i - 1].origin);
		if (d != null && dt > 0 && dt < 0.3 && d > 800) teleports++;
	}
	if (teleports >= 2) reasons.push('origin teleported ' + teleports + ' times (likely snapshot hitch)');

	if (fpsSum && fpsSum.p50 < 20) {
		const rend = (connected[connected.length - 1].renderer || '').toLowerCase();
		if (/swiftshader|llvmpipe|software/.test(rend))
			warnings.push('fps p50 ' + fpsSum.p50 + ' on ' + connected[connected.length - 1].renderer + ' (renderer, not net)');
		else
			warnings.push('fps p50 ' + fpsSum.p50);
	}

	if (proxyStats && proxyStats.conns) {
		const drops = (proxyStats.totals && (proxyStats.totals.wsDrops + proxyStats.totals.udpDrops)) || 0;
		if (drops > 0) reasons.push('proxy dropped ' + drops + ' datagrams (backpressure or send error)');
		for (const c of proxyStats.conns) {
			if (c.bufferedAmount > 32 * 1024)
				reasons.push('proxy WebSocket bufferedAmount ' + c.bufferedAmount + ' bytes');
			if (c.wsRttMs != null && c.wsRttMs > 20)
				reasons.push('proxy reports WS RTT ' + c.wsRttMs + 'ms');
		}
	}

	return {
		deficient: reasons.length > 0,
		reasons,
		warnings,
		n: samples.length,
		connected: connected.length,
		ping: pingSum,
		packetloss: lossSum,
		sinceLastMessage: sinceSum,
		fps: fpsSum,
		packetsReceived: recv.length ? { first: recv[0], last: recv[recv.length - 1], delta: recv[recv.length - 1] - recv[0] } : null,
		teleports,
	};
}

// Lag-spike attribution. samples are rows collected by `client spikes`:
// {t, state, proxyConn, spy}. Each leg answers a different question:
//
//   state.sinceLastMessage / mtime stall  → the engine did not get a snapshot
//   proxyConn.gapsServerToBrowser         → datagrams stalled before the proxy
//   spy.rx (browser WebSocket receive)    → frames stalled proxy→browser
//   spy.tx + maxBufferedAfter             → the page could not flush its sends
//   fps while all legs clean              → renderer, not the bridge
function judgeSpikes(samples) {
	const reasons = [];
	const warnings = [];
	const connected = samples.filter((s) => s && s.state && s.state.connected && s.state.signon >= 4);
	if (!samples.length) {
		reasons.push('no spike samples');
		return { deficient: true, reasons, warnings, n: 0, connected: 0 };
	}
	if (!connected.length) {
		reasons.push('client never reached match; spikes needs an in-game or spectating session');
		return { deficient: true, reasons, warnings, n: samples.length, connected: 0 };
	}

	const maxOf = (arr) => arr.reduce((m, x) => (x != null && (m == null || x > m) ? x : m), null);

	const msgGaps = connected.map((s) =>
		s.state.sinceLastMessage != null ? s.state.sinceLastMessage * 1000 : null).filter((x) => x != null);
	const fpsVals = connected.map((s) => s.state.fps).filter((x) => typeof x === 'number' && x >= 0);
	const recv = connected.map((s) => s.state.packetsReceived).filter((x) => typeof x === 'number');

	let mtimeStallMax = 0;
	for (let i = 1; i < connected.length; i++) {
		const a = connected[i - 1], b = connected[i];
		if (typeof a.state.mtime === 'number' && typeof b.state.mtime === 'number' &&
			typeof a.t === 'number' && typeof b.t === 'number') {
			const wall = b.t - a.t;
			const adv = Math.max(b.state.mtime - a.state.mtime, 0);
			const stall = Math.max(0, wall - adv * 1000 - 150); // server clock may lag wall clock slightly
			if (stall > mtimeStallMax) mtimeStallMax = stall;
		}
	}

	// Worst leg over each sample's trailing window.
	const srvGapMax = maxOf(connected.map((s) =>
		s.proxyConn && s.proxyConn.gapsServerToBrowser ? legWorst(s.proxyConn.gapsServerToBrowser) : null));
	const browserRxGapMax = maxOf(connected.map((s) =>
		s.spy && s.spy.rx ? s.spy.rx.maxGapMs : null));
	const browserTxGapMax = maxOf(connected.map((s) =>
		s.spy && s.spy.tx ? s.spy.tx.maxGapMs : null));
	const bufferedMax = maxOf(connected.map((s) =>
		s.spy && s.spy.maxBufferedAfter != null ? s.spy.maxBufferedAfter : null));
	const proxyBufMax = maxOf(connected.map((s) =>
		s.proxyConn && s.proxyConn.bufferedAmount != null ? s.proxyConn.bufferedAmount : null));
	const proxyDropsDelta = (() => {
		const first = connected[0].proxyConn, last = connected[connected.length - 1].proxyConn;
		if (!first || !last) return null;
		const d = (last.wsDrops + last.udpDrops) - (first.wsDrops + first.udpDrops);
		return d > 0 ? d : 0;
	})();
	const dropsRecent = maxOf(connected.map((s) =>
		s.proxyConn && s.proxyConn.dropsLast10s != null ? s.proxyConn.dropsLast10s : null));

	const engineGapMax = maxOf(msgGaps);
	const fpsMin = fpsVals.length ? Math.min.apply(null, fpsVals) : null;

	const out = {
		deficient: false,
		reasons,
		warnings,
		n: samples.length,
		connected: connected.length,
		engineMessageGapMaxMs: engineGapMax,
		mtimeStallMaxMs: Math.round(mtimeStallMax),
		serverToBrowserGapMaxMs: srvGapMax,
		browserRxGapMaxMs: browserRxGapMax,
		browserTxGapMaxMs: browserTxGapMax,
		spyBufferedMax: bufferedMax,
		proxyBufferedMax: proxyBufMax,
		proxyDropsDuringRun: proxyDropsDelta,
		proxyDropsLast10sPeak: dropsRecent,
		fpsMin,
		attribution: [],
	};

	// Attribute: walk from the server outward and stop at the first leg that
	// actually saw a gap. A leg that stayed quiet is exonerated.
	if ((engineGapMax != null && engineGapMax > 300) || mtimeStallMax > 300) {
		if (srvGapMax != null && srvGapMax > 200)
			out.attribution.push('server→proxy: dedicated paused ' + srvGapMax + 'ms (proxy saw no datagrams)');
		else if (browserRxGapMax != null && browserRxGapMax > 200)
			out.attribution.push('proxy→browser: WS delivery stalled ' + browserRxGapMax + 'ms in-page though the proxy kept receiving');
		else if (browserTxGapMax != null && browserTxGapMax > 300)
			out.attribution.push('client tx: page stopped sending for ' + browserTxGapMax + 'ms (main thread wedged)');
		else if (fpsMin != null && fpsMin < 15)
			out.attribution.push('engine/render: datagrams flowed but frames took ' + Math.round(1000 / Math.max(fpsMin, 0.01)) + 'ms');
		else
			out.attribution.push('unattributed: engine saw ' + Math.round(engineGapMax) + 'ms message gap with every measured leg quiet');
	}

	if (out.attribution.length) {
		reasons.push(out.attribution.join('; '));
	} else if (engineGapMax != null) {
		warnings.push('no >300ms engine gap this run (worst ' + Math.round(engineGapMax) + 'ms)');
	}
	if (srvGapMax != null && srvGapMax <= 200 && engineGapMax != null && engineGapMax <= 300 && fpsMin != null && fpsMin < 15)
		warnings.push('fps dipped to ' + Math.round(fpsMin) + ' with clean net — renderer-side hitch');
	if (proxyDropsDelta > 0)
		reasons.push('proxy dropped ' + proxyDropsDelta + ' datagrams during the run (bufferedAmount backpressure)');
	if (proxyBufMax != null && proxyBufMax > 32 * 1024)
		reasons.push('proxy→browser bufferedAmount peaked at ' + proxyBufMax + ' bytes');
	if (bufferedMax != null && bufferedMax > 64 * 1024)
		warnings.push('browser ws.send bufferedAmount peaked at ' + bufferedMax + ' bytes');
	if (recv.length >= 2 && recv[recv.length - 1] <= recv[0])
		reasons.push('packetsReceived did not increase (' + recv[0] + ' → ' + recv[recv.length - 1] + ')');
	out.deficient = reasons.length > 0;
	return out;
}

function legWorst(windows) {
	if (!windows) return null;
	const vals = [];
	for (const key of Object.keys(windows)) {
		const w = windows[key];
		if (w && w.maxGapMs != null) vals.push(w.maxGapMs);
	}
	if (!vals.length) return null;
	return Math.max.apply(null, vals);
}

module.exports = {
	parseHostPort,
	summarize,
	probeDirectUdp,
	probeViaProxy,
	judgeBridge,
	judgeClient,
	judgeSpikes,
};
