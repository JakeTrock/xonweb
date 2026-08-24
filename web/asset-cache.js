#!/usr/bin/env node
// Disk cache for proxied map/curl downloads.
// Layout (repo-root .cache/ is gitignored):
//   .cache/assets/hosts/<origin-host>/<basename>-<urlhash>.bin
//   .cache/assets/hosts/<origin-host>/<basename>-<urlhash>.json
//   .cache/assets/servers/<game-server>.json   // optional index by dedicated
// Entries expire 3 days after last access.

'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const CACHE_TTL_MS = 3 * 24 * 60 * 60 * 1000;
const HOST_DIR_NAME = 'hosts';
const SERVER_DIR_NAME = 'servers';

function cacheRoot(repoRoot) {
	return path.join(repoRoot, '.cache', 'assets');
}

function sha16(s) {
	return crypto.createHash('sha256').update(String(s)).digest('hex').slice(0, 16);
}

function safeHost(hostname) {
	const h = String(hostname || 'unknown').toLowerCase().replace(/^\[|\]$/g, '');
	const cleaned = h.replace(/[^a-z0-9._-]/g, '_');
	return cleaned.slice(0, 120) || 'unknown';
}

function safeBasename(url) {
	let base = 'file';
	try {
		const p = new URL(url).pathname || '';
		base = path.posix.basename(p) || 'file';
	} catch (e) { /* keep default */ }
	base = base.replace(/[^A-Za-z0-9._-]/g, '_');
	if (!base || base === '.' || base === '..') base = 'file';
	if (base.length > 80) base = base.slice(0, 80);
	return base;
}

function safeGameServer(addr) {
	const s = String(addr || '').trim();
	if (!s || s.length > 128) return null;
	if (!/^[A-Za-z0-9.:\[\]_-]+$/.test(s)) return null;
	if (s.indexOf('..') !== -1) return null;
	return s.replace(/[:\[\]]/g, '_');
}

function keyFor(repoRoot, url) {
	let host = 'unknown';
	try { host = safeHost(new URL(url).hostname); } catch (e) { /* keep */ }
	const name = safeBasename(url) + '-' + sha16(url);
	const dir = path.join(cacheRoot(repoRoot), HOST_DIR_NAME, host);
	return {
		url: url,
		host: host,
		name: name,
		dir: dir,
		bin: path.join(dir, name + '.bin'),
		meta: path.join(dir, name + '.json'),
	};
}

function readJson(file) {
	return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function writeJson(file, obj) {
	fs.mkdirSync(path.dirname(file), { recursive: true });
	const tmp = file + '.tmp-' + process.pid;
	fs.writeFileSync(tmp, JSON.stringify(obj));
	fs.renameSync(tmp, file);
}

function unlinkQuiet(file) {
	try { fs.unlinkSync(file); } catch (e) { /* missing */ }
}

function expired(meta, now) {
	const t = Number(meta && (meta.lastAccess || meta.storedAt)) || 0;
	return !t || (now - t) > CACHE_TTL_MS;
}

function create(repoRoot) {
	const root = cacheRoot(repoRoot);
	const inflight = new Map();
	// Tri-state: null = untested, true/false = probed. A read-only checkout
	// (k8s hostPath) must degrade to pass-through proxying, never crash the
	// download (the ENOENT-in-createWriter uncaughtException class).
	let writable = null;

	function ensureWritable() {
		if (writable !== null) return writable;
		try {
			fs.mkdirSync(root, { recursive: true });
			fs.accessSync(root, fs.constants.W_OK);
			fs.writeFileSync(path.join(root, '.probe'), 'ok');
			fs.unlinkSync(path.join(root, '.probe'));
			writable = true;
		} catch (e) {
			writable = false;
			console.error('[asset-cache] disabled (read-only?): ' + e.message);
		}
		return writable;
	}

	function writableNow() {
		return ensureWritable();
	}

	function lookup(url) {
		const key = keyFor(repoRoot, url);
		let meta;
		try { meta = readJson(key.meta); } catch (e) { return null; }
		const now = Date.now();
		if (expired(meta, now)) {
			unlinkQuiet(key.bin);
			unlinkQuiet(key.meta);
			return null;
		}
		let st;
		try { st = fs.statSync(key.bin); } catch (e) { return null; }
		if (!st.isFile() || st.size <= 0) return null;
		return { key: key, meta: meta, size: st.size, bin: key.bin };
	}

	function touch(url, gameServer) {
		const key = keyFor(repoRoot, url);
		let meta;
		try { meta = readJson(key.meta); } catch (e) { return; }
		meta.lastAccess = Date.now();
		if (gameServer) {
			if (!Array.isArray(meta.gameServers)) meta.gameServers = [];
			if (meta.gameServers.indexOf(gameServer) === -1) {
				meta.gameServers.push(gameServer);
				if (meta.gameServers.length > 32) meta.gameServers = meta.gameServers.slice(-32);
			}
			recordServer(gameServer, url, key);
		}
		try { writeJson(key.meta, meta); } catch (e) { /* ignore */ }
	}

	function recordServer(gameServer, url, key) {
		const safe = safeGameServer(gameServer);
		if (!safe) return;
		const file = path.join(root, SERVER_DIR_NAME, safe + '.json');
		let idx;
		try { idx = readJson(file); } catch (e) { idx = { server: gameServer, urls: [] }; }
		idx.server = gameServer;
		idx.lastAccess = Date.now();
		if (!Array.isArray(idx.urls)) idx.urls = [];
		if (idx.urls.indexOf(url) === -1) {
			idx.urls.push(url);
			if (idx.urls.length > 64) idx.urls = idx.urls.slice(-64);
		}
		idx.host = key && key.host;
		try { writeJson(file, idx); } catch (e) { /* ignore */ }
	}

	function createWriter(url) {
		if (!ensureWritable()) {
			// No-op writer: teeUpstreamToCacheAndRes keeps streaming to the
			// client, nothing is persisted, commit reports clean success.
			return {
				key: keyFor(repoRoot, url),
				write: function () { return true; },
				once: function () {},
				abort: function () {},
				commit: function (extra, cb) { if (cb) cb(null, null); },
			};
		}
		const key = keyFor(repoRoot, url);
		fs.mkdirSync(key.dir, { recursive: true });
		const tmp = key.bin + '.tmp-' + process.pid + '-' + Date.now();
		const ws = fs.createWriteStream(tmp);
		let aborted = false;
		let size = 0;
		return {
			key: key,
			write: function (chunk) {
				if (aborted) return true;
				size += chunk.length;
				return ws.write(chunk);
			},
			once: function (ev, fn) { ws.once(ev, fn); },
			abort: function () {
				if (aborted) return;
				aborted = true;
				ws.destroy();
				unlinkQuiet(tmp);
			},
			commit: function (extra, cb) {
				if (aborted) {
					if (cb) cb(new Error('aborted'));
					return;
				}
				ws.end(function () {
					if (aborted) {
						unlinkQuiet(tmp);
						if (cb) cb(new Error('aborted'));
						return;
					}
					try {
						fs.renameSync(tmp, key.bin);
						const now = Date.now();
						const meta = {
							url: url,
							host: key.host,
							contentType: extra && extra.contentType || 'application/octet-stream',
							size: size,
							storedAt: now,
							lastAccess: now,
							gameServers: extra && extra.gameServer ? [extra.gameServer] : [],
						};
						writeJson(key.meta, meta);
						if (extra && extra.gameServer)
							recordServer(extra.gameServer, url, key);
						if (cb) cb(null, meta);
					} catch (e) {
						unlinkQuiet(tmp);
						unlinkQuiet(key.bin);
						if (cb) cb(e);
					}
				});
			},
		};
	}

	function sweep() {
		const now = Date.now();
		let removed = 0;
		const hostsDir = path.join(root, HOST_DIR_NAME);
		let hosts;
		try { hosts = fs.readdirSync(hostsDir); } catch (e) { hosts = []; }
		for (let i = 0; i < hosts.length; i++) {
			const dir = path.join(hostsDir, hosts[i]);
			let names;
			try { names = fs.readdirSync(dir); } catch (e) { continue; }
			for (let j = 0; j < names.length; j++) {
				const n = names[j];
				if (n.indexOf('.tmp-') !== -1) {
					try {
						const st = fs.statSync(path.join(dir, n));
						if (now - st.mtimeMs > 60 * 60 * 1000) {
							unlinkQuiet(path.join(dir, n));
							removed++;
						}
					} catch (e) { /* skip */ }
					continue;
				}
				if (!n.endsWith('.json')) continue;
				const metaPath = path.join(dir, n);
				const binPath = path.join(dir, n.slice(0, -5) + '.bin');
				let meta;
				try { meta = readJson(metaPath); } catch (e) {
					unlinkQuiet(metaPath);
					unlinkQuiet(binPath);
					removed++;
					continue;
				}
				if (expired(meta, now)) {
					unlinkQuiet(metaPath);
					unlinkQuiet(binPath);
					removed++;
				}
			}
			try {
				if (fs.readdirSync(dir).length === 0) fs.rmdirSync(dir);
			} catch (e) { /* not empty */ }
		}
		const serversDir = path.join(root, SERVER_DIR_NAME);
		let serverFiles;
		try { serverFiles = fs.readdirSync(serversDir); } catch (e) { serverFiles = []; }
		for (let i = 0; i < serverFiles.length; i++) {
			const p = path.join(serversDir, serverFiles[i]);
			let idx;
			try { idx = readJson(p); } catch (e) {
				unlinkQuiet(p);
				removed++;
				continue;
			}
			if (expired(idx, now)) {
				unlinkQuiet(p);
				removed++;
			}
		}
		return removed;
	}

	function stats() {
		const now = Date.now();
		const hosts = {};
		const servers = [];
		let entries = 0;
		let bytes = 0;
		const hostsDir = path.join(root, HOST_DIR_NAME);
		let hostNames;
		try { hostNames = fs.readdirSync(hostsDir); } catch (e) { hostNames = []; }
		for (let i = 0; i < hostNames.length; i++) {
			const host = hostNames[i];
			const dir = path.join(hostsDir, host);
			let names;
			try { names = fs.readdirSync(dir); } catch (e) { continue; }
			const list = [];
			for (let j = 0; j < names.length; j++) {
				if (!names[j].endsWith('.json')) continue;
				let meta;
				try { meta = readJson(path.join(dir, names[j])); } catch (e) { continue; }
				if (expired(meta, now)) continue;
				const ageMs = now - (meta.lastAccess || meta.storedAt || now);
				list.push({
					url: meta.url,
					size: meta.size,
					ageMs: ageMs,
					ttlMs: CACHE_TTL_MS - ageMs,
					gameServers: meta.gameServers || [],
				});
				entries++;
				bytes += Number(meta.size) || 0;
			}
			if (list.length) hosts[host] = list;
		}
		const serversDir = path.join(root, SERVER_DIR_NAME);
		let serverFiles;
		try { serverFiles = fs.readdirSync(serversDir); } catch (e) { serverFiles = []; }
		for (let i = 0; i < serverFiles.length; i++) {
			let idx;
			try { idx = readJson(path.join(serversDir, serverFiles[i])); } catch (e) { continue; }
			if (expired(idx, now)) continue;
			servers.push({
				server: idx.server,
				urlCount: (idx.urls || []).length,
				lastAccess: idx.lastAccess,
				urls: idx.urls || [],
			});
		}
		return {
			dir: root,
			ttlMs: CACHE_TTL_MS,
			ttlDays: 3,
			entries: entries,
			bytes: bytes,
			inflight: inflight.size,
			hosts: hosts,
			servers: servers,
		};
	}

	return {
		root: root,
		ttlMs: CACHE_TTL_MS,
		writable: writableNow,
		lookup: lookup,
		touch: touch,
		createWriter: createWriter,
		sweep: sweep,
		stats: stats,
		inflight: inflight,
		keyFor: function (url) { return keyFor(repoRoot, url); },
	};
}

module.exports = {
	CACHE_TTL_MS: CACHE_TTL_MS,
	create: create,
	cacheRoot: cacheRoot,
	safeGameServer: safeGameServer,
};
