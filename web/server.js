#!/usr/bin/env node
// Simple static file server for Xonotic WASM
// Serves web files and game assets with proper headers for SharedArrayBuffer

const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = 9080;
const WEB_DIR = path.join(__dirname, '..', 'web');
const ASSETS_DIR = path.join(__dirname, '..', 'assets');

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
};

// Track 404s for debugging
const notFoundPaths = new Set();
const notFoundCounts = {};

const server = http.createServer((req, res) => {
	let urlPath = decodeURIComponent(req.url.split('?')[0]);
	
	// Handle /404stats endpoint - returns JSON of 404 paths and counts
	if (urlPath === '/404stats') {
		res.writeHead(200, {
			'Content-Type': 'application/json',
			'Cross-Origin-Opener-Policy': 'same-origin',
			'Cross-Origin-Embedder-Policy': 'require-corp',
			'Access-Control-Allow-Origin': '*',
		});
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
			res.writeHead(200, {
				'Content-Type': 'application/json',
				'Cross-Origin-Opener-Policy': 'same-origin',
				'Cross-Origin-Embedder-Policy': 'require-corp',
				'Access-Control-Allow-Origin': '*',
			});
			res.end(JSON.stringify(files));
			console.log('200 /filelist (' + files.length + ' files)');
		} catch (err) {
			res.writeHead(500);
			res.end('Error: ' + err.message);
		}
		return;
	}
	
	// Handle /game/ prefix - serve from assets directory
	let filePath;
	if (urlPath.startsWith('/game/')) {
		filePath = path.join(ASSETS_DIR, 'game', urlPath.substring('/game/'.length));
	} else {
		filePath = path.join(WEB_DIR, urlPath);
	}
	
	// Default to index.html
	if (urlPath === '/' || urlPath === '') {
		filePath = path.join(WEB_DIR, 'index.html');
	}
	
	// Security: prevent path traversal
	const resolvedPath = path.resolve(filePath);
	if (!resolvedPath.startsWith(WEB_DIR) && !resolvedPath.startsWith(ASSETS_DIR)) {
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
		res.setHeader('Access-Control-Allow-Origin', '*');
		
		// Prevent caching of JS files (so new builds are always served)
		if (ext === '.js' || ext === '.html') {
			res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
		}
		
		// Support range requests for large files
		const range = req.headers.range;
		if (range) {
			const parts = range.replace(/bytes=/, '').split('-');
			const start = parseInt(parts[0], 10);
			const end = parts[1] ? parseInt(parts[1], 10) : stats.size - 1;
			const chunkSize = end - start + 1;
			
			res.writeHead(206, {
				'Content-Range': `bytes ${start}-${end}/${stats.size}`,
				'Accept-Ranges': 'bytes',
				'Content-Length': chunkSize,
			});
			
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
	console.log(`Press Ctrl+C to stop`);
});
