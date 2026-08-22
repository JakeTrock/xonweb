// Agent harness bridge. Loaded only when ?harness=1.
// Exposes window.__xon for the test/harness/client CLI.
(function () {
	if (window.__xon) return;

	var RING = 4000;
	var FIND_CAP = 800;
	var TREE_CAP = 2000;
	var t0 = Date.now();
	var engine = [];
	var htmlRing = [];
	var jsRing = [];
	var ready = false;
	var lastWsUrl = '';

	function now() {
		return (Date.now() - t0) / 1000;
	}

	function push(arr, rec) {
		arr.push(rec);
		if (arr.length > RING) arr.splice(0, arr.length - RING);
	}

	// ?harness=1&ship=1: mirror engine lines to the static server (POST
	// /englog). The network process still delivers a fetch() after the
	// renderer main thread wedges, so the last line before a hang survives.
	var shipEnabled = /(?:^|[?&])ship=1(?:&|$)/.test(location.search);
	var shipIdMatch = location.search.match(/[?&]id=([ab])/);
	var shipId = shipIdMatch ? shipIdMatch[1] : 'a';
	function ship(text, err) {
		if (!shipEnabled) return;
		// sendBeacon hands the request to the network process synchronously;
		// fetch() would not be dispatched until the current task ends, which
		// never happens if the engine hangs right after printing.
		var body = (err ? '[E] ' : '') + text;
		try {
			// sync XHR: guaranteed handed to the network stack before returning,
			// even if the engine wedges on the very next statement (beacons and
			// async fetch() are queued and may be lost to a synchronous hang)
			var xhr = new XMLHttpRequest();
			xhr.open('POST', '/englog?id=' + shipId, false);
			xhr.send(body);
		} catch (e) { }
	}

	// Watchdog worker: runs off the main thread, so it can still report when
	// the engine wedges mid-frame. The main thread feeds it the latest console
	// ring plus a heartbeat; if the heartbeat stops, the worker ships the last
	// lines to /englog.
	function startWatchdog() {
		if (!shipEnabled || !window.Worker) return;
		window.__xwWdState = { created: false, ticks: 0, acked: false };
		var src =
			'var last=0,lines=[],sent=false;' +
			'onmessage=function(e){' +
			'if(e.data&&e.data.tick){' +
			'last=Date.now();' +
			'if(e.data.lines)lines=e.data.lines;' +
			'if(!self._acked){self._acked=true;postMessage({wdack:true});}' +
			'}' +
			'};' +
			'setInterval(function(){if(!sent&&last&&Date.now()-last>4000){sent=true;' +
			// Blob workers have no base URI: the englog URL must be absolute.
			'var xhr=new XMLHttpRequest();xhr.open("POST","' + location.origin + '/englog?id=' + shipId + '",false);' +
			'xhr.send("[WORKDOG] main thread hung; last console lines:\\n"+lines.map(function(l){return l.t+"s "+l.text;}).join("\\n"));}' +
			'},1000);';
		try {
			var w = new Worker(URL.createObjectURL(new Blob([src], { type: 'text/javascript' })));
			window.__xwWdState.created = true;
			w.onmessage = function (e) {
				if (e.data && e.data.wdack) {
					window.__xwWdState.acked = true;
					push(jsRing, { t: now(), text: 'watchdog-armed', type: 'log' });
				}
			};
			setInterval(function () {
				window.__xwWdState.ticks++;
				try { w.postMessage({ tick: true, lines: engine.slice(-40).map(function (l) { return { t: l.t, text: l.text }; }) }); } catch (e) { }
			}, 500);
		} catch (e) {
			window.__xwWdState.error = String(e);
		}
	}

	function hookPrint() {
		var M = window.Module;
		if (!M) return;
		var prevPrint = M.print;
		var prevErr = M.printErr;
		M.print = function (text) {
			var s = String(text);
			push(engine, { t: now(), text: s, err: false });
			ship(s, false);
			if (s.indexOf('Opening WebSocket to ') === 0)
				lastWsUrl = s.slice('Opening WebSocket to '.length);
			if (s.indexOf('Starting engine') !== -1) ready = true;
			if (typeof prevPrint === 'function') prevPrint(text);
		};
		M.printErr = function (text) {
			var s = String(text);
			push(engine, { t: now(), text: s, err: true });
			ship(s, true);
			if (typeof prevErr === 'function') prevErr(text);
		};
		var prevReady = M.onEngineReady;
		M.onEngineReady = function () {
			ready = true;
			if (typeof prevReady === 'function') prevReady();
		};
	}

	function hookJsConsole() {
		['log', 'info', 'warn', 'error'].forEach(function (type) {
			var orig = console[type];
			console[type] = function () {
				var text = Array.prototype.slice.call(arguments).map(function (a) {
					try { return typeof a === 'string' ? a : JSON.stringify(a); }
					catch (e) { return String(a); }
				}).join(' ');
				push(jsRing, { t: now(), text: text, type: type });
				return orig.apply(console, arguments);
			};
		});
		window.addEventListener('error', function (ev) {
			push(jsRing, { t: now(), text: String(ev.message || ev.error || ev), type: 'pageerror' });
		});
	}

	function snapshotHtmlConsole() {
		var el = document.getElementById('console');
		if (!el) return [];
		return Array.prototype.map.call(el.children, function (div) {
			return { t: 0, text: div.textContent || '', err: div.className === 'error' };
		});
	}

	function resolvePath(p) {
		if (!p) return '/game';
		p = String(p);
		if (p.charAt(0) === '/') return p;
		return '/game/' + p;
	}

	function fsApi() {
		if (typeof FS === 'undefined') throw new Error('FS not available (engine not started)');
		return FS;
	}

	function fsStatRaw(path) {
		var FS = fsApi();
		try {
			var st = FS.stat(path);
			var mode = st.mode;
			var isDir = FS.isDir(mode);
			return { exists: true, path: path, size: st.size || 0, isDir: !!isDir };
		} catch (e) {
			return { exists: false, path: path };
		}
	}

	function globToRegExp(glob) {
		var s = String(glob);
		var out = '^';
		for (var i = 0; i < s.length; i++) {
			var c = s.charAt(i);
			if (c === '*' && s.charAt(i + 1) === '*') {
				if (s.charAt(i + 2) === '/') {
					out += '(?:.*/)?';
					i += 2;
				} else {
					out += '.*';
					i += 1;
				}
			} else if (c === '*') {
				out += '[^/]*';
			} else if (c === '?') {
				out += '[^/]';
			} else if ('+.^${}()|[]\\'.indexOf(c) !== -1) {
				out += '\\' + c;
			} else {
				out += c;
			}
		}
		out += '$';
		return new RegExp(out);
	}

	function walkFind(dir, re, out) {
		if (out.length >= FIND_CAP) return;
		var FS = fsApi();
		var names;
		try { names = FS.readdir(dir); } catch (e) { return; }
		for (var i = 0; i < names.length; i++) {
			var name = names[i];
			if (name === '.' || name === '..') continue;
			var p = dir === '/' ? '/' + name : dir + '/' + name;
			var st = fsStatRaw(p);
			if (!st.exists) continue;
			if (re.test(p) || re.test(p.replace(/^\/game\//, '')) || re.test(name))
				out.push(st);
			if (st.isDir) walkFind(p, re, out);
			if (out.length >= FIND_CAP) return;
		}
	}

	function walkTree(dir, depth, maxDepth, out) {
		if (out.length >= TREE_CAP) return;
		var FS = fsApi();
		var names;
		try { names = FS.readdir(dir); } catch (e) { return; }
		for (var i = 0; i < names.length; i++) {
			var name = names[i];
			if (name === '.' || name === '..') continue;
			var p = dir === '/' ? '/' + name : dir + '/' + name;
			var st = fsStatRaw(p);
			if (!st.exists) continue;
			st.depth = depth;
			out.push(st);
			if (st.isDir && depth < maxDepth) walkTree(p, depth + 1, maxDepth, out);
			if (out.length >= TREE_CAP) return;
		}
	}

	function isMostlyText(bytes) {
		var n = Math.min(bytes.length, 4096);
		if (n === 0) return true;
		var bad = 0;
		for (var i = 0; i < n; i++) {
			var c = bytes[i];
			if (c === 0) return false;
			if (c < 9 || (c > 13 && c < 32)) bad++;
		}
		return bad / n < 0.05;
	}

	function decodeUtf8(bytes) {
		try { return new TextDecoder('utf-8', { fatal: false }).decode(bytes); }
		catch (e) {
			var s = '';
			for (var i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
			return s;
		}
	}

	function vis(id, showClass) {
		var el = document.getElementById(id);
		if (!el) return false;
		if (el.classList.contains('hidden')) return false;
		if (showClass && !el.classList.contains(showClass)) return false;
		if (el.style && el.style.display === 'none') return false;
		return true;
	}

	function connectionSnapshot() {
		try {
			if (typeof Module !== 'undefined' && typeof Module.ccall === 'function') {
				var raw = Module.ccall('em_state', 'string', []);
				if (raw) return JSON.parse(raw);
			}
		} catch (e) { /* engine not up */ }
		var connected = engine.some(function (l) { return l.text.indexOf('Connection established') !== -1; });
		return { connected: connected, signon: connected ? 4 : 0, signons: 4 };
	}

	function currentPhase() {
		var settings = vis('settingsPanel');
		var loading = vis('loadingOverlay');
		var browser = vis('serverBrowser', 'show');
		var mapDl = document.getElementById('mapDownloadOverlay');
		var mapLoading = !!(mapDl && mapDl.style.display === 'block');
		var playBtn = document.getElementById('playBtn');
		var playIdle = !!(settings && playBtn && !playBtn.disabled);
		var st = connectionSnapshot();
		var connected = !!st.connected;
		var signedOn = connected && (st.signon >= (st.signons || 4) || st.signon >= 4);
		if (playIdle) return 'settings';
		if (mapLoading) return 'loading-map';
		if (connected && signedOn) return 'match';
		if (connected) return 'connecting';
		if (loading && !browser) return 'loading';
		if (browser) return 'browser';
		if (loading) return 'loading';
		if (settings) return 'settings';
		return 'unknown';
	}

	function readHtmlOverlayState() {
		var toolbar = document.getElementById('toolbar');
		var mapDl = document.getElementById('mapDownloadOverlay');
		var loadStatus = document.getElementById('loadingStatus');
		var browserStatus = document.getElementById('serverBrowserStatus');
		var mapDlStatus = document.getElementById('mapDlStatus');
		var rows = document.querySelectorAll('#serverListBody tr');
		return {
			settingsPanel: vis('settingsPanel'),
			loadingOverlay: vis('loadingOverlay'),
			loadingStatus: loadStatus ? (loadStatus.textContent || '') : '',
			toolbar: !!(toolbar && toolbar.style.display === 'flex'),
			gameMenu: vis('gameMenu', 'show'),
			connectDialog: vis('connectDialog', 'show'),
			serverBrowser: vis('serverBrowser', 'show'),
			serverCount: rows.length,
			serverBrowserStatus: browserStatus ? (browserStatus.textContent || '') : '',
			mapDownload: !!(mapDl && mapDl.style.display === 'block'),
			mapDownloadStatus: mapDlStatus ? (mapDlStatus.textContent || '') : '',
			htmlConsole: vis('console', 'show'),
			playDisabled: !!(document.getElementById('playBtn') && document.getElementById('playBtn').disabled),
			joinOverlay: 'unknown',
			phase: currentPhase(),
		};
	}

	function stateFallback() {
		var errors = engine.filter(function (l) {
			return /Host_Error|Connect: failed/i.test(l.text);
		}).slice(-10).map(function (l) { return l.text; });
		var connected = engine.some(function (l) { return l.text.indexOf('Connection established') !== -1; });
		var signon = 0;
		for (var i = engine.length - 1; i >= 0; i--) {
			var m = engine[i].text.match(/signon stage (\d+) of (\d+)/i);
			if (m) { signon = parseInt(m[1], 10); break; }
		}
		return {
			ready: ready,
			source: 'js',
			connected: connected,
			signon: signon,
			map: '',
			origin: null,
			angles: null,
			velocity: null,
			frametime: null,
			fps: null,
			ping: null,
			packetloss: null,
			packetsReceived: null,
			packetsSent: null,
			sinceLastMessage: null,
			renderer: glInfo().renderer || '',
			errors: errors,
			ui: readHtmlOverlayState(),
		};
	}

	function stateFromWasm() {
		try {
			if (typeof Module === 'undefined' || typeof Module.ccall !== 'function') return null;
			var s = Module.ccall('em_state', 'string', []);
			if (!s) return null;
			var obj = JSON.parse(s);
			obj.source = 'wasm';
			obj.ready = true;
			obj.ui = readHtmlOverlayState();
			return obj;
		} catch (e) {
			return null;
		}
	}

	function glInfo() {
		var canvas = document.getElementById('canvas');
		var info = { renderer: '', vendor: '', contextLost: false, api: null };
		if (!canvas) return info;
		try {
			var gl = canvas.getContext('webgl2') || canvas.getContext('webgl');
			if (!gl) return info;
			info.api = gl instanceof WebGL2RenderingContext ? 'webgl2' : 'webgl';
			info.contextLost = typeof gl.isContextLost === 'function' && gl.isContextLost();
			var ext = gl.getExtension('WEBGL_debug_renderer_info');
			if (ext) {
				info.vendor = gl.getParameter(ext.UNMASKED_VENDOR_WEBGL) || '';
				info.renderer = gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) || '';
			} else {
				info.vendor = gl.getParameter(gl.VENDOR) || '';
				info.renderer = gl.getParameter(gl.RENDERER) || '';
			}
		} catch (e) {
			info.error = String(e.message || e);
		}
		return info;
	}

	function netInfo() {
		var proxy = '';
		var el = document.getElementById('wsProxyUrl');
		if (el) proxy = el.value || '';
		var out = {
			proxyUrl: proxy,
			lastWsUrl: lastWsUrl,
			wsOpen: /WebSocket connected/i.test((engine[engine.length - 1] || {}).text || '') ||
				engine.some(function (l) { return l.text === 'WebSocket connected'; }),
		};
		try {
			var spy = netspySummary(10000);
			if (spy && spy.active) out.spy = spy.active;
		} catch (e) { /* spy never armed */ }
		return out;
	}

	// --- WebSocket frame spy (?harness=1 only) ---
	// Wraps window.WebSocket before the engine loads so every binary frame
	// on the proxy tunnel is timestamped in the page. This is what lets the
	// harness attribute a lag spike to one leg:
	//   server → proxy → browser rx | browser tx → engine main thread.
	var NETSPY_RING = 8192;
	var NETSPY_SOCKETS = 8;
	var RealWebSocket = window.WebSocket;
	var netSpySockets = [];

	function pushSpyEvent(rec, dir, size, bufferedAfter) {
		rec.events.push([now(), dir, size, bufferedAfter || 0]);
		if (rec.events.length > NETSPY_RING) rec.events.splice(0, rec.events.length - NETSPY_RING);
	}

	window.WebSocket = function (url, protocols) {
		var ws = protocols !== undefined ? new RealWebSocket(url, protocols) : new RealWebSocket(url);
		var rec = {
			url: String(url),
			t0: now(),
			closedAt: null,
			errors: 0,
			sendErrors: 0,
			maxBufferedAfter: 0,
			events: [],
		};
		netSpySockets.push(rec);
		if (netSpySockets.length > NETSPY_SOCKETS) netSpySockets.splice(0, netSpySockets.length - NETSPY_SOCKETS);
		ws.addEventListener('message', function (ev) {
			if (typeof ev.data === 'string') return; // text frames are not game traffic
			pushSpyEvent(rec, 'r', ev.data ? (ev.data.byteLength || ev.data.size || 0) : 0, 0);
		});
		ws.addEventListener('close', function () { rec.closedAt = now(); });
		ws.addEventListener('error', function () { rec.errors++; });
		var origSend = ws.send.bind(ws);
		ws.send = function (data) {
			var size = data ? (data.byteLength || data.size || data.length || 0) : 0;
			var r = origSend(data);
			var buffered = ws.bufferedAmount || 0;
			if (buffered > rec.maxBufferedAfter) rec.maxBufferedAfter = buffered;
			pushSpyEvent(rec, 's', size, buffered);
			return r;
		};
		return ws;
	};
	try {
		window.WebSocket.prototype = RealWebSocket.prototype;
		['CONNECTING', 'OPEN', 'CLOSING', 'CLOSED'].forEach(function (k) {
			window.WebSocket[k] = RealWebSocket[k];
		});
	} catch (e) { /* keep native constants if frozen */ }

	function interarrivalStats(events, dir, windowSec) {
		var cutoff = now() - windowSec;
		var prevT = null;
		var gaps = [];
		var count = 0;
		var bytes = 0;
		for (var i = 0; i < events.length; i++) {
			var ev = events[i];
			if (ev[1] !== dir || ev[0] < cutoff) continue;
			count++;
			bytes += ev[2];
			if (prevT !== null) {
				var dt = (ev[0] - prevT) * 1000;
				gaps.push(dt);
			}
			prevT = ev[0];
		}
		if (!gaps.length)
			return { count: count, bytesPerSec: Math.round(bytes / Math.max(windowSec, 0.001)), maxGapMs: null, p50GapMs: null, p95GapMs: null };
		gaps.sort(function (a, b) { return a - b; });
		return {
			count: count,
			bytesPerSec: Math.round(bytes / Math.max(windowSec, 0.001)),
			maxGapMs: Math.round(gaps[gaps.length - 1]),
			p50GapMs: Math.round(gaps[Math.floor((gaps.length - 1) * 0.5)]),
			p95GapMs: Math.round(gaps[Math.floor((gaps.length - 1) * 0.95)]),
		};
	}

	function netspySummary(windowMs) {
		var win = (windowMs || 5000) / 1000;
		var sockets = netSpySockets.map(function (rec) {
			return {
				url: rec.url,
				t0: rec.t0,
				open: rec.closedAt === null,
				closedAt: rec.closedAt,
				errors: rec.errors,
				sendErrors: rec.sendErrors,
				maxBufferedAfter: rec.maxBufferedAfter,
				rx: interarrivalStats(rec.events, 'r', win),
				tx: interarrivalStats(rec.events, 's', win),
			};
		});
		var active = null;
		for (var i = sockets.length - 1; i >= 0; i--) {
			if (sockets[i].open && (sockets[i].rx.count > 0 || sockets[i].tx.count > 0)) { active = sockets[i]; break; }
		}
		if (!active && sockets.length) active = sockets[sockets.length - 1];
		return { windowMs: windowMs || 5000, sockets: sockets, active: active };
	}

	function netspyReset() {
		// Keep the records themselves: live sockets still push into them.
		netSpySockets.forEach(function (rec) { rec.events = []; rec.maxBufferedAfter = 0; });
		return { reset: true };
	}

	function canvasDataUrl() {
		var canvas = document.getElementById('canvas');
		if (!canvas) throw new Error('no canvas');
		return canvas.toDataURL('image/png');
	}

	function exec(cmd) {
		if (typeof Module === 'undefined' || typeof Module.ccall !== 'function')
			throw new Error('em_exec unavailable (engine not started)');
		Module.ccall('em_exec', null, ['string'], [String(cmd)]);
	}

	function condumpThenRead() {
		exec('condump harness/condump.txt');
		var candidates = [
			'/game/xonotic-maps.pk3dir/harness/condump.txt',
			'/game/xonotic-data.pk3dir/harness/condump.txt',
			'/game/harness/condump.txt',
		];
		for (var i = 0; i < candidates.length; i++) {
			var st = fsStatRaw(candidates[i]);
			if (st.exists && !st.isDir) {
				return { path: candidates[i], text: fsCat(candidates[i], 2 * 1024 * 1024).text };
			}
		}
		return { path: null, text: '', error: 'condump file not found in expected write dirs' };
	}

	function fsCat(path, maxBytes) {
		var FS = fsApi();
		path = resolvePath(path);
		var st = fsStatRaw(path);
		if (!st.exists) return { exists: false, path: path };
		if (st.isDir) return { exists: true, path: path, isDir: true, error: 'is a directory' };
		maxBytes = maxBytes || 256 * 1024;
		var n = Math.min(st.size, maxBytes);
		var buf = new Uint8Array(n);
		var stream = FS.open(path, 'r');
		FS.read(stream, buf, 0, n, 0);
		FS.close(stream);
		if (!isMostlyText(buf)) return { exists: true, path: path, binary: true, size: st.size };
		return { exists: true, path: path, text: decodeUtf8(buf), size: st.size, truncated: st.size > n };
	}

	async function fetchJson(url) {
		var r = await fetch(url);
		if (!r.ok) throw new Error('HTTP ' + r.status + ' for ' + url);
		return r.json();
	}

	window.__xon = {
		get ready() { return ready; },
		exec: exec,
		state: function () {
			return stateFromWasm() || stateFallback();
		},
		shot: function (opts) {
			opts = opts || {};
			var target = opts.target || 'canvas';
			if (target === 'canvas') return canvasDataUrl();
			throw new Error('shot target "' + target + '" is handled by CDP, not the page');
		},
		con: {
			get engine() { return engine.slice(); },
			get html() { return snapshotHtmlConsole(); },
			get js() { return jsRing.slice(); },
		},
		conDump: condumpThenRead,
		fs: {
			ls: function (path) {
				path = resolvePath(path);
				var FS = fsApi();
				var names = FS.readdir(path);
				var out = [];
				for (var i = 0; i < names.length; i++) {
					if (names[i] === '.' || names[i] === '..') continue;
					var child = path === '/' ? '/' + names[i] : path + '/' + names[i];
					out.push(fsStatRaw(child));
				}
				return { path: path, entries: out };
			},
			stat: function (path) { return fsStatRaw(resolvePath(path)); },
			has: function (path) { return fsStatRaw(resolvePath(path)); },
			cat: function (path, maxBytes) { return fsCat(path, maxBytes); },
			tree: function (path, depth) {
				path = resolvePath(path);
				depth = depth == null ? 2 : depth;
				var out = [];
				walkTree(path, 0, depth, out);
				return { path: path, depth: depth, truncated: out.length >= TREE_CAP, entries: out };
			},
			find: function (glob) {
				var re = globToRegExp(glob);
				var out = [];
				walkFind('/game', re, out);
				return { glob: String(glob), truncated: out.length >= FIND_CAP, entries: out };
			},
			downloads: function () {
				var M = window.Module || {};
				var files = [];
				try {
					if (M._downloadedFiles && typeof M._downloadedFiles.forEach === 'function')
						M._downloadedFiles.forEach(function (f) { files.push(f); });
				} catch (e) { /* ignore */ }
				return {
					assetVersion: M.assetVersion || null,
					fileCount: M._fileCount || 0,
					totalDownloaded: M._totalDownloaded || 0,
					downloadErrors: M._downloadErrors || 0,
					errorFiles: (M._errorFiles || []).slice(0, 50),
					downloaded: files.slice(0, 200),
					downloadedCount: files.length,
				};
			},
			compare: async function () {
				var list = await fetchJson('/filelist');
				var missing = [];
				var mismatch = [];
				var present = 0;
				for (var i = 0; i < list.length; i++) {
					var rel = list[i].path;
					var st = fsStatRaw('/game/' + rel);
					if (!st.exists) missing.push({ path: rel, size: list[i].size });
					else if (!st.isDir && st.size !== list[i].size)
						mismatch.push({ path: rel, memfs: st.size, server: list[i].size });
					else present++;
				}
				return {
					serverFiles: list.length,
					present: present,
					missing: missing.slice(0, 200),
					missingCount: missing.length,
					mismatch: mismatch.slice(0, 50),
					mismatchCount: mismatch.length,
				};
			},
			notFound: async function () { return fetchJson('/404stats'); },
			filelist: async function () { return fetchJson('/filelist'); },
		},
		ui: readHtmlOverlayState,
		net: netInfo,
		netspy: function (windowMs) { return netspySummary(windowMs); },
		netspyReset: netspyReset,
		gl: glInfo,
		phase: currentPhase,
		play: function (opts) {
			opts = opts || {};
			if (opts.name)
				document.getElementById('playerName').value = opts.name;
			if (opts.proxy) {
				var p1 = document.getElementById('wsProxyUrl');
				var p2 = document.getElementById('wsProxyUrlConnect');
				if (p1) p1.value = opts.proxy;
				if (p2) p2.value = opts.proxy;
			}
			var btn = document.getElementById('playBtn');
			if (!btn) throw new Error('Play button missing');
			if (btn.disabled) throw new Error('Play already clicked');
			btn.click();
			return { play: true, name: document.getElementById('playerName').value };
		},
		servers: function () {
			var fromUi = [];
			if (window.xonUi && typeof window.xonUi.getServers === 'function')
				fromUi = window.xonUi.getServers();
			var rows = [];
			document.querySelectorAll('#serverListBody tr').forEach(function (tr) {
				var tds = tr.querySelectorAll('td');
				rows.push({
					address: tr.dataset.address || '',
					map: tr.dataset.map || '',
					hostname: tds[0] ? tds[0].textContent : '',
					players: tds[2] ? tds[2].textContent : '',
					ping: tds[3] ? tds[3].textContent : '',
				});
			});
			return {
				phase: currentPhase(),
				status: (document.getElementById('serverBrowserStatus') || {}).textContent || '',
				servers: fromUi.length ? fromUi : rows,
				rows: rows,
			};
		},
		pick: function (query, mapName) {
			query = String(query || '').trim();
			if (!query) throw new Error('pick requires an address, hostname, or map');
			var q = query.toLowerCase();
			var rows = document.querySelectorAll('#serverListBody tr');
			for (var i = 0; i < rows.length; i++) {
				var tr = rows[i];
				var blob = ((tr.dataset.address || '') + ' ' + (tr.dataset.map || '') + ' ' + (tr.textContent || '')).toLowerCase();
				if (blob.indexOf(q) !== -1) {
					tr.click();
					return { via: 'row', address: tr.dataset.address, map: tr.dataset.map };
				}
			}
			if (window.xonUi && typeof window.xonUi.connectToServer === 'function') {
				var proxy = (document.getElementById('wsProxyUrl') || {}).value || 'ws://127.0.0.1:8081';
				var map = mapName || 'unknown';
				window.xonUi.connectToServer(query, map, proxy);
				return { via: 'connectToServer', address: query, map: map };
			}
			throw new Error('no server matching "' + query + '" and connectToServer is not exposed');
		},
		refreshServers: function () {
			if (window.xonUi && typeof window.xonUi.refreshServerList === 'function') {
				window.xonUi.refreshServerList();
				return { refresh: true };
			}
			var btn = document.getElementById('refreshServersBtn');
			if (btn) { btn.click(); return { refresh: true, via: 'button' }; }
			throw new Error('cannot refresh server list');
		},
	};

	hookPrint();
	hookJsConsole();
	startWatchdog();
})();
