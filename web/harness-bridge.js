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

	function hookPrint() {
		var M = window.Module;
		if (!M) return;
		var prevPrint = M.print;
		var prevErr = M.printErr;
		M.print = function (text) {
			var s = String(text);
			push(engine, { t: now(), text: s, err: false });
			if (s.indexOf('Opening WebSocket to ') === 0)
				lastWsUrl = s.slice('Opening WebSocket to '.length);
			if (s.indexOf('Starting engine') !== -1) ready = true;
			if (typeof prevPrint === 'function') prevPrint(text);
		};
		M.printErr = function (text) {
			push(engine, { t: now(), text: String(text), err: true });
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
		return {
			proxyUrl: proxy,
			lastWsUrl: lastWsUrl,
			wsOpen: /WebSocket connected/i.test((engine[engine.length - 1] || {}).text || '') ||
				engine.some(function (l) { return l.text === 'WebSocket connected'; }),
		};
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
})();
