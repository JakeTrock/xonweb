// Browser-side error telemetry for xonweb.
//
// Captures window.onerror / unhandledrejection plus the tail of the engine
// console (fed via XonErrorCapture.engineLine from index.html's Module.print /
// printErr) and batches them to POST /errors (see lib/errorlog.js). Silent
// no-op if /errors is unavailable or disabled server-side.
//
// Skipped entirely on harness pages (?harness=1): those runs are agent-driven
// and their diagnostics go through test/ artifacts instead.

(function () {
	'use strict';
	if (/[?&]harness=1/.test(window.location.search)) return;

	var RING_MAX = 50;
	var FLUSH_MS = 5000;
	var MAX_BATCH = 20;
	var MAX_EVENTS_QUEUED = 100;

	var ring = [];
	var queue = [];
	var timer = null;

	function distinctId() {
		try {
			var k = 'xonweb_distinct_id';
			var v = window.localStorage.getItem(k);
			if (!v) {
				v = 'anon-' + Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
				window.localStorage.setItem(k, v);
			}
			return v;
		} catch (e) {
			return 'anon-session';
		}
	}

	function engineTail() {
		return ring.length ? ring.join('\n') : undefined;
	}

	function enqueue(ev) {
		if (!ev || typeof ev !== 'object') return;
		ev.distinct_id = distinctId();
		ev.url = String(window.location.href).slice(0, 500);
		ev.ts = new Date().toISOString();
		if (ring.length) ev.engine_tail = engineTail();
		queue.push(ev);
		if (queue.length > MAX_EVENTS_QUEUED) queue.splice(0, queue.length - MAX_EVENTS_QUEUED);
		scheduleFlush();
	}

	function scheduleFlush() {
		if (timer) return;
		timer = setTimeout(flush, FLUSH_MS);
	}

	function flush() {
		timer = null;
		if (!queue.length) return;
		var batch = queue.splice(0, MAX_BATCH);
		try {
			fetch('/errors', {
				method: 'POST',
				body: JSON.stringify(batch),
				keepalive: batch.length * 4 < 60,
				headers: { 'Content-Type': 'application/json' },
			}).catch(function () { /* sink down: stay silent */ });
		} catch (e) { /* older browsers / CSP */ }
		if (queue.length) scheduleFlush();
	}

	window.addEventListener('error', function (e) {
		var msg = e && e.message ? e.message : String(e && e.error || 'error event');
		enqueue({
			event: 'browser_error',
			message: msg,
			stack: e && e.error && e.error.stack ? String(e.error.stack).split('\n').slice(0, 25).join('\n') : undefined,
			detail: [e && e.filename, e && e.lineno, e && e.colno].filter(Boolean).join(':').slice(0, 300),
		});
	});

	window.addEventListener('unhandledrejection', function (e) {
		var r = e && e.reason;
		enqueue({
			event: 'browser_error',
			message: r instanceof Error ? (r.message || String(r)) : String(r || '(non-error rejection)'),
			stack: r instanceof Error && r.stack ? String(r.stack).split('\n').slice(0, 25).join('\n') : undefined,
			detail: 'unhandledrejection',
		});
	});

	// Swallowed failures are logged via console.error, not thrown — capture
	// those too or they never reach the sink.
	try {
		var origError = console.error.bind(console);
		console.error = function () {
			try {
				var first = arguments[0];
				var msg = first instanceof Error ? (first.message || String(first)) : String(first);
				if (msg) {
					enqueue({
						event: 'browser_error',
						message: msg.slice(0, 2000),
						stack: first instanceof Error && first.stack ? String(first.stack).split('\n').slice(0, 25).join('\n') : undefined,
						detail: 'console.error',
					});
				}
			} catch (e) { /* never break logging */ }
			origError.apply(null, arguments);
		};
	} catch (e) { /* very old engines */ }

	window.XonErrorCapture = {
		// Called by index.html for every engine console line (print/printErr).
		engineLine: function (text) {
			text = String(text).slice(0, 300);
			ring.push(text);
			if (ring.length > RING_MAX) ring.splice(0, ring.length - RING_MAX);
			maybeReportLoadFailure(text);
		},
		manual: function (message, detail) {
			enqueue({ event: 'browser_error', message: String(message).slice(0, 2000), detail: detail });
		},
	};

	// Asset-load failures print via the engine's stdout (console.log), which
	// nothing else captures — without this a missing precache model is
	// invisible in the sink (only its later 'null model' VM warning shows).
	// Throttled + deduped: map loads can spam dozens of these.
	var LOADFAIL_RE = /(not found|couldn't load|failed to load|is of unknown|unsupported type)/i;
	var LOADFAIL_IGNORE_RE = /(gfx\/|menudot|qplaque|ttl_main|mainmenu|\.glsl|shader )/i;
	var loadfailSeen = {};
	var loadfailCount = 0;
	function maybeReportLoadFailure(line) {
		if (loadfailCount >= 10) return;
		if (!LOADFAIL_RE.test(line) || LOADFAIL_IGNORE_RE.test(line)) return;
		var key = line.slice(0, 160);
		if (loadfailSeen[key]) return;
		loadfailSeen[key] = 1;
		loadfailCount++;
		enqueue({
			event: 'asset_load_failure',
			message: key,
			detail: 'engine console',
		});
	}
})();
