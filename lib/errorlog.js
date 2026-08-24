#!/usr/bin/env node
// Shared JSONL error sink for xonweb services (web/server.js, ws-proxy).
//
// Every event is one JSON line in <repoRoot>/data/errors.jsonl, rotated at
// ERRORLOG_MAX_BYTES to .jsonl.1 (one generation kept). Appends are atomic
// enough for our purposes: single process per file today; if two services
// ever share the file, lines may interleave but never truncate.
//
// Design rules:
// - Never throw. Logging must not take the game server down.
// - Never block: fs.appendFile + rotation guard via a simple in-flight flag.
// - No deps.

'use strict';

const fs = require('fs');
const path = require('path');

const MAX_BYTES = 10 * 1024 * 1024;
const MAX_LINE_BYTES = 64 * 1024;

function create(repoRoot) {
	const dir = path.join(repoRoot, 'data');
	const file = path.join(dir, 'errors.jsonl');
	let rotating = false;
	let warnedDir = false;

	function ensureDir() {
		if (warnedDir) return;
		try {
			fs.mkdirSync(dir, { recursive: true });
			warnedDir = true;
		} catch (e) { /* retry next event */ }
	}

	function rotateIfNeeded() {
		if (rotating) return;
		fs.stat(file, (err, st) => {
			if (err || !st || st.size < MAX_BYTES) return;
			rotating = true;
			fs.rename(file, file + '.1', () => {
				rotating = false;
			});
		});
	}

	// One event object -> one JSON line. Extra fields are preserved; long
	// strings are clamped so a runaway stack cannot bloat the file.
	function log(event) {
		if (!event || typeof event !== 'object') return;
		const rec = Object.assign({ ts: new Date().toISOString() }, event);
		if (!rec.event) rec.event = 'server_error';
		for (const k of ['message', 'stack', 'source', 'engine_tail', 'url', 'detail']) {
			if (typeof rec[k] === 'string' && rec[k].length > 8000) {
				rec[k] = rec[k].slice(0, 8000);
			}
		}
		let line;
		try {
			line = JSON.stringify(rec);
		} catch (e) {
			return;
		}
		if (line.length > MAX_LINE_BYTES) {
			line = JSON.stringify({
				ts: rec.ts,
				event: rec.event,
				message: '[oversized record dropped]',
			});
		}
		line += '\n';
		ensureDir();
		fs.appendFile(file, line, () => {});
		rotateIfNeeded();
	}

	// Error-ish value (Error instance or anything thrown) -> plain object.
	function fromError(err, extra) {
		const rec = extra && typeof extra === 'object' ? Object.assign({}, extra) : {};
		if (err instanceof Error) {
			rec.message = err.message || String(err);
			if (err.stack) rec.stack = err.stack.split('\n').slice(0, 25).join('\n');
			if (err.code) rec.detail = 'code=' + err.code;
		} else if (err !== undefined && err !== null) {
			rec.message = String(err);
		} else {
			rec.message = '(non-error rejection)';
		}
		return rec;
	}

	// Install process-level capture. Returns an uninstall function.
	function attachProcess(sourceName) {
		const onUncaught = (err) => {
			log(Object.assign(fromError(err), { event: 'server_error', source: sourceName, detail: 'uncaughtException' }));
		};
		const onRejection = (reason) => {
			log(Object.assign(fromError(reason), { event: 'server_error', source: sourceName, detail: 'unhandledRejection' }));
		};
		process.on('uncaughtException', onUncaught);
		process.on('unhandledRejection', onRejection);

		// Mirror console.error into the sink without changing stdout behavior.
		const origErr = console.error.bind(console);
		console.error = function (...args) {
			try {
				const first = args[0];
				if (first instanceof Error || typeof first === 'string') {
					log(Object.assign(fromError(first), {
						event: 'server_error',
						source: sourceName,
						detail: 'console.error',
						engine_tail: args.length > 1 ? args.slice(1).map(String).join(' ').slice(0, 2000) : undefined,
					}));
				}
			} catch (e) { /* never break logging */ }
			origErr(...args);
		};

		return function detach() {
			process.removeListener('uncaughtException', onUncaught);
			process.removeListener('unhandledRejection', onRejection);
			console.error = origErr;
		};
	}

	return { log, fromError, attachProcess, file };
}

module.exports = { create };
