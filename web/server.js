#!/usr/bin/env node
// Simple static file server for Xonotic WASM
// Serves web files and game assets with proper headers for SharedArrayBuffer

const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = 9080;
const REPO_ROOT = path.join(__dirname, '..');
const WEB_DIR = path.join(REPO_ROOT, 'web');
const ASSETS_DIR = path.join(REPO_ROOT, 'assets');
const ASSETS_GAME = path.join(ASSETS_DIR, 'game');
// Official Xonotic data (texture packs, shaders, env). Served as /game/ fallback
// so the WASM client can fetch map textures on connect without copying 2.7GB
// into assets/ (which would also land in /filelist and the first-run cache).
const DATA_DIR = path.join(REPO_ROOT, 'xonotic', 'data');

const MIME_TYPES = {
	'.html': 'text/html',
	'.js': 'application/javascript',
	'.wasm': 'application/wasm',
	'.json': 'application/json',
	'.css': 'text/css',
	'.png': 'image/png',
	'.jpg': 'image/jpeg',
	'.jpeg': 'image/jpeg',
	'.tga': 'image/x-tga',
	'.dds': 'image/x-dds',
	'.bsp': 'application/octet-stream',
	'.dat': 'application/octet-stream',
	'.pak': 'application/octet-stream',
	'.pk3': 'application/zip',
	'.cfg': 'text/plain',
	'.txt': 'text/plain',
	'.wav': 'audio/wav',
	'.ogg': 'audio/ogg',
	'.mp3': 'audio/mpeg',
	'.iqm': 'application/octet-stream',
	'.md3': 'application/octet-stream',
	'.dpm': 'application/octet-stream',
	'.zym': 'application/octet-stream',
	'.mapinfo': 'text/plain',
	'.waypoints': 'application/octet-stream',
	'.lno': 'application/octet-stream',
	'.pk3dir': 'application/octet-stream',
	'.shader': 'text/plain',
};

// Map packs, textures, sounds, models fetched after the first-run /filelist.
// Long-lived so a second visit does not re-download them over the network.
// Do not cache .dat/.cfg/.js/.html — those change with gamecode and engine builds.
const CACHEABLE_EXTS = new Set([
	'.tga', '.jpg', '.jpeg', '.png', '.pcx', '.dds',
	'.shader', '.pk3', '.bsp',
	'.ogg', '.wav', '.mp3',
	'.iqm', '.md3', '.dpm', '.zym',
	'.lno', '.waypoints', '.mapinfo',
]);

function cacheControlFor(urlPath, ext) {
	if (ext === '.js' || ext === '.html')
		return 'no-store, no-cache, must-revalidate';
	if ((urlPath.startsWith('/game/') || urlPath.startsWith('/mapdl/')) && CACHEABLE_EXTS.has(ext))
		return 'public, max-age=604800';
	return null;
}

function coopHeaders(req, extra) {
	const origin = req && req.headers && req.headers.origin;
	const headers = {
		'Cross-Origin-Opener-Policy': 'same-origin',
		'Cross-Origin-Embedder-Policy': 'require-corp',
		// COEP require-corp: credentialed fetch() fails if ACAO is "*".
		'Cross-Origin-Resource-Policy': 'same-origin',
		'Vary': 'Origin',
	};
	if (origin) {
		headers['Access-Control-Allow-Origin'] = origin;
		headers['Access-Control-Allow-Credentials'] = 'true';
		headers['Access-Control-Allow-Headers'] = 'Content-Type, Range';
		headers['Access-Control-Allow-Methods'] = 'GET, HEAD, OPTIONS';
	}
	return Object.assign(headers, extra || {});
}

function applyCoop(req, res) {
	const h = coopHeaders(req);
	for (const k of Object.keys(h)) res.setHeader(k, h[k]);
}

function isInside(resolved, root) {
	const r = path.resolve(root);
	return resolved === r || resolved.startsWith(r + path.sep);
}

function skipDirent(name) {
	if (!name || name[0] === '.') return true;
	if (name === 'qcsrc' || name === 'node_modules' || name === 'cmake') return true;
	return false;
}

function safeRelPath(relPath) {
	if (!relPath) return '';
	const rel = String(relPath).replace(/\\/g, '/').replace(/^\/+/, '');
	if (rel.includes('\0')) return null;
	const parts = rel.split('/');
	for (let i = 0; i < parts.length; i++) {
		if (parts[i] === '..') return null;
	}
	return rel;
}

// Official compiled maps are hashed zips at xonotic/data/<map>-<hash>-<hash>.pk3,
// not solarium.pk3 on the community CDN. /mapfind locates those so connectToServer
// can install them into MEMFS without putting every map on /filelist.
function findLocalMapPk3s(mapName) {
	const needle = String(mapName || '').trim().toLowerCase();
	if (!needle || needle === 'unknown' || needle.length > 64) return [];
	if (!/^[a-z0-9][a-z0-9._-]*$/.test(needle)) return [];
	const dirs = [
		{ dir: path.join(ASSETS_GAME, 'xonotic-maps.pk3dir'), relBase: 'xonotic-maps.pk3dir' },
		{ dir: path.join(ASSETS_GAME, 'xonotic-data.pk3dir'), relBase: 'xonotic-data.pk3dir' },
		{ dir: DATA_DIR, relBase: '' },
		{ dir: path.join(DATA_DIR, 'xonotic-maps.pk3dir'), relBase: 'xonotic-maps.pk3dir' },
		{ dir: path.join(DATA_DIR, 'xonotic-data.pk3dir'), relBase: 'xonotic-data.pk3dir' },
	];
	const out = [];
	const seen = new Set();
	for (let d = 0; d < dirs.length; d++) {
		const spec = dirs[d];
		let names;
		try { names = fs.readdirSync(spec.dir); } catch (e) { continue; }
		for (let i = 0; i < names.length; i++) {
			const n = names[i];
			if (!/\.pk3$/i.test(n)) continue;
			if (n.toLowerCase().indexOf(needle) === -1) continue;
			const rel = spec.relBase ? spec.relBase + '/' + n : n;
			if (seen.has(rel)) continue;
			seen.add(rel);
			try {
				const st = fs.statSync(path.join(spec.dir, n));
				if (!st.isFile()) continue;
				out.push({ path: rel, size: st.size, filename: n });
			} catch (e) { /* skip */ }
		}
	}
	out.sort(function (a, b) { return a.filename.length - b.filename.length; });
	return out;
}

function resolveGameFile(relPath) {
	const rel = safeRelPath(relPath);
	if (rel === null || rel === '') return null;
	const candidates = [
		{ file: path.resolve(ASSETS_GAME, rel), root: ASSETS_GAME },
		{ file: path.resolve(DATA_DIR, rel), root: DATA_DIR },
	];
	for (let i = 0; i < candidates.length; i++) {
		const c = candidates[i];
		if (!isInside(c.file, c.root)) continue;
		try {
			const st = fs.statSync(c.file);
			if (st.isFile()) return c.file;
		} catch (e) { /* missing */ }
	}
	return null;
}

function walkFiles(dir, base, out, seen, cap) {
	if (out.length >= cap) return;
	let entries;
	try {
		entries = fs.readdirSync(dir, { withFileTypes: true });
	} catch (e) {
		return;
	}
	for (const entry of entries) {
		if (out.length >= cap) return;
		if (skipDirent(entry.name)) continue;
		const rel = base ? base + '/' + entry.name : entry.name;
		if (seen.has(rel)) continue;
		const full = path.join(dir, entry.name);
		if (entry.isDirectory()) {
			walkFiles(full, rel, out, seen, cap);
		} else if (entry.isFile()) {
			seen.add(rel);
			try {
				out.push({ path: rel, size: fs.statSync(full).size });
			} catch (e) { /* race */ }
		}
	}
}

// Track 404s for debugging
const notFoundPaths = new Set();
const notFoundCounts = {};

// Harness live views listen on 9322/9323. Those ports are often filtered on
// the LAN even when :9080 works, so we also serve them here.
const VIEW_PORTS = { a: 9322, b: 9323 };

function viewHtml(id) {
	const shot = '/view/' + id + '/shot.png';
	return `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<title>xonweb client ${id}</title>
<style>
  html, body { margin: 0; background: #111; color: #ddd; font-family: sans-serif; }
  header { padding: 8px 12px; background: #1a1a2e; font-size: 14px; }
  img { display: block; width: 100%; height: auto; background: #000; min-height: 200px; }
</style>
</head>
<body>
<header>You reached 10.103.0.115:9080 — client <b>${id}</b>
 — <a href="${shot}" style="color:#ff9900">shot.png</a>
 · <a href="/view/a/" style="color:#ff9900">A</a>
 · <a href="/view/b/" style="color:#ff9900">B</a></header>
<img id="v" alt="client ${id}" src="${shot}">
<script>
setInterval(function () {
  document.getElementById('v').src = '${shot}?' + Date.now();
}, 350);
</script>
</body>
</html>`;
}

function proxyViewShot(req, res, port) {
	const proxyReq = http.get({
		hostname: '127.0.0.1',
		port: port,
		path: '/shot.png',
		timeout: 4000,
	}, function (proxyRes) {
		const headers = {
			'Content-Type': proxyRes.headers['content-type'] || 'image/png',
			'Cache-Control': 'no-store, no-cache, must-revalidate',
			'Access-Control-Allow-Origin': '*',
		};
		if (proxyRes.headers['content-length'])
			headers['Content-Length'] = proxyRes.headers['content-length'];
		res.writeHead(proxyRes.statusCode || 200, headers);
		proxyRes.pipe(res);
	});
	proxyReq.on('timeout', function () {
		proxyReq.destroy();
		res.writeHead(504, coopHeaders(req, { 'Content-Type': 'text/plain' }));
		res.end('view timeout (cdp/view server not answering)');
	});
	proxyReq.on('error', function (err) {
		res.writeHead(502, coopHeaders(req, { 'Content-Type': 'text/plain' }));
		res.end('view proxy error: ' + err.message);
	});
}

const server = http.createServer((req, res) => {
	let urlPath = decodeURIComponent(req.url.split('?')[0]);
	const remote = (req.socket && req.socket.remoteAddress) || '?';
	console.log(remote + ' ' + req.method + ' ' + urlPath);

	if (urlPath === '/hello') {
		res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' });
		res.end('xonweb ok\nyour ip: ' + remote + '\nhost: 10.103.0.115:9080\nviews: /view/a/  /view/b/\n');
		return;
	}

	if (req.method === 'OPTIONS') {
		res.writeHead(204, coopHeaders(req));
		res.end();
		return;
	}

	const plainHtml = { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'Access-Control-Allow-Origin': '*' };
	if (urlPath === '/view' || urlPath === '/view/') {
		res.writeHead(200, plainHtml);
		res.end('<!DOCTYPE html><meta charset="utf-8"><title>xonweb views</title><body style="background:#111;color:#ddd;font-family:sans-serif;padding:24px"><h1>You reached 10.103.0.115:9080</h1><p><a href="/view/a/" style="color:#ff9900">PlayerA</a> · <a href="/view/b/" style="color:#ff9900">PlayerB</a></p></body>');
		return;
	}
	const viewMatch = urlPath.match(/^\/view\/([ab])\/?(shot\.png)?$/);
	if (viewMatch) {
		const id = viewMatch[1];
		const port = VIEW_PORTS[id];
		if (viewMatch[2] === 'shot.png') {
			proxyViewShot(req, res, port);
			return;
		}
		res.writeHead(200, plainHtml);
		res.end(viewHtml(id));
		return;
	}

	applyCoop(req, res);

	// Handle /404stats endpoint - returns JSON of 404 paths and counts
	if (urlPath === '/404stats') {
		res.writeHead(200, coopHeaders(req, { 'Content-Type': 'application/json' }));
		res.end(JSON.stringify({ paths: Array.from(notFoundPaths).sort(), counts: notFoundCounts }));
		return;
	}
	
	// Handle /filelist endpoint - returns JSON list of all asset files with sizes
	if (urlPath === '/filelist') {
		const gameDir = path.join(ASSETS_DIR, 'game');
		const files = [];
		function walkDir(dir, base) {
			const entries = fs.readdirSync(dir, { withFileTypes: true });
			for (const entry of entries) {
				const fullPath = path.join(dir, entry.name);
				const relPath = base ? base + '/' + entry.name : entry.name;
				if (entry.isDirectory()) {
					walkDir(fullPath, relPath);
				} else {
					const stat = fs.statSync(fullPath);
					files.push({ path: relPath, size: stat.size });
				}
			}
		}
		try {
			walkDir(gameDir, '');
			res.writeHead(200, coopHeaders(req, { 'Content-Type': 'application/json' }));
			res.end(JSON.stringify(files));
			console.log('200 /filelist (' + files.length + ' files)');
		} catch (err) {
			res.writeHead(500);
			res.end('Error: ' + err.message);
		}
		return;
	}

	// List files under a /game/ prefix from assets/game first, then xonotic/data.
	// Used to prefetch shaders/textures for the map being joined. Not a boot
	// manifest — /filelist stays assets-only so first-run cache stays small.
	if (urlPath === '/dirlist') {
		const qs = (req.url.split('?')[1] || '');
		const params = new URLSearchParams(qs);
		const prefix = safeRelPath(params.get('prefix') || '');
		if (prefix === null) {
			res.writeHead(400, coopHeaders(req, { 'Content-Type': 'application/json' }));
			res.end(JSON.stringify({ error: 'bad prefix' }));
			return;
		}
		const cap = 8000;
		const files = [];
		const seen = new Set();
		const roots = [
			{ dir: prefix ? path.resolve(ASSETS_GAME, prefix) : ASSETS_GAME, root: ASSETS_GAME },
			{ dir: prefix ? path.resolve(DATA_DIR, prefix) : DATA_DIR, root: DATA_DIR },
		];
		for (let i = 0; i < roots.length; i++) {
			if (!isInside(roots[i].dir, roots[i].root)) continue;
			walkFiles(roots[i].dir, prefix, files, seen, cap);
		}
		res.writeHead(200, coopHeaders(req, { 'Content-Type': 'application/json' }));
		res.end(JSON.stringify({ prefix: prefix, files: files, truncated: files.length >= cap }));
		return;
	}
	
	if (urlPath === '/mapfind') {
		const qs = (req.url.split('?')[1] || '');
		const params = new URLSearchParams(qs);
		const name = params.get('name') || '';
		const files = findLocalMapPk3s(name);
		res.writeHead(200, coopHeaders(req, { 'Content-Type': 'application/json' }));
		res.end(JSON.stringify({ name: name, files: files, count: files.length }));
		return;
	}

	// Handle /mapdl/<filename> - proxy map pk3 downloads from community CDN
	// This avoids CORS issues with direct browser-to-CDN fetches
	if (urlPath.startsWith('/mapdl/')) {
		const filename = urlPath.substring('/mapdl/'.length);
		const cdnUrl = 'http://dl.xonotic.fps.gratis/' + filename;
		console.log('Proxying map download: ' + filename + ' from ' + cdnUrl);
		
		const http = require('http');
		const proxyReq = http.get(cdnUrl, function(proxyRes) {
			if (proxyRes.statusCode !== 200) {
				console.log('CDN returned ' + proxyRes.statusCode + ' for ' + filename);
				res.writeHead(proxyRes.statusCode);
				res.end();
				return;
			}
			const contentLength = proxyRes.headers['content-length'] || 0;
			res.writeHead(200, coopHeaders(req, {
				'Content-Type': 'application/zip',
				'Content-Length': contentLength,
				'Cache-Control': 'public, max-age=604800',
			}));
			proxyRes.pipe(res);
		});
		proxyReq.on('error', function(err) {
			console.error('Map download proxy error:', err.message);
			res.writeHead(502);
			res.end('Proxy error: ' + err.message);
		});
		return;
	}
	
	// /game/<path> → assets/game first, then xonotic/data (official texture packs)
	let filePath;
	if (urlPath.startsWith('/game/')) {
		const rel = urlPath.substring('/game/'.length);
		const resolvedGame = resolveGameFile(rel);
		if (resolvedGame) {
			filePath = resolvedGame;
		} else {
			filePath = path.join(ASSETS_GAME, rel);
		}
	} else {
		filePath = path.join(WEB_DIR, urlPath);
	}

	// Default to index.html
	if (urlPath === '/' || urlPath === '') {
		filePath = path.join(WEB_DIR, 'index.html');
	}

	// Security: prevent path traversal
	const resolvedPath = path.resolve(filePath);
	if (!isInside(resolvedPath, WEB_DIR) && !isInside(resolvedPath, ASSETS_DIR) && !isInside(resolvedPath, DATA_DIR)) {
		res.writeHead(403);
		res.end('Forbidden');
		return;
	}
	
	// Check if file exists
	fs.stat(resolvedPath, (err, stats) => {
		if (err || !stats.isFile()) {
			if (!notFoundCounts[urlPath]) {
				notFoundCounts[urlPath] = 0;
				notFoundPaths.add(urlPath);
			}
			notFoundCounts[urlPath]++;
			console.error('404: ' + urlPath + ' (count: ' + notFoundCounts[urlPath] + ')');
			res.writeHead(404);
			res.end('Not Found: ' + urlPath);
			return;
		}
		
		const ext = path.extname(resolvedPath).toLowerCase();
		const mime = MIME_TYPES[ext] || 'application/octet-stream';
		
		// Set headers for SharedArrayBuffer support and CORS
		res.setHeader('Content-Type', mime);
		res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
		res.setHeader('Cross-Origin-Embedder-Policy', 'require-corp');
		applyCoop(req, res);
		res.setHeader('Last-Modified', stats.mtime.toUTCString());

		const cacheControl = cacheControlFor(urlPath, ext);
		if (cacheControl) res.setHeader('Cache-Control', cacheControl);
		
		// Support range requests for large files
		const range = req.headers.range;
		if (range) {
			const parts = range.replace(/bytes=/, '').split('-');
			const start = parseInt(parts[0], 10);
			const end = parts[1] ? parseInt(parts[1], 10) : stats.size - 1;
			const chunkSize = end - start + 1;
			
			const rangeHeaders = {
				'Content-Range': `bytes ${start}-${end}/${stats.size}`,
				'Accept-Ranges': 'bytes',
				'Content-Length': chunkSize,
			};
			if (cacheControl) rangeHeaders['Cache-Control'] = cacheControl;
			res.writeHead(206, rangeHeaders);
			
			const stream = fs.createReadStream(resolvedPath, { start, end });
			stream.pipe(res);
		} else {
			res.setHeader('Content-Length', stats.size);
			res.setHeader('Accept-Ranges', 'bytes');
			res.writeHead(200);
			
			const stream = fs.createReadStream(resolvedPath);
			stream.pipe(res);
		}
		
		// Log requests (except favicon)
		if (!urlPath.includes('favicon')) {
			const sizeKB = (stats.size / 1024).toFixed(1);
			console.log(`200 ${urlPath} (${sizeKB} KB)`);
		}
	});
});

server.listen(PORT, '0.0.0.0', () => {
	console.log(`Xonotic WASM server running at http://localhost:${PORT}/`);
	console.log(`Web files: ${WEB_DIR}`);
	console.log(`Game assets: ${ASSETS_DIR}`);
	console.log(`Data fallback: ${DATA_DIR}`);
	console.log(`Press Ctrl+C to stop`);
});
