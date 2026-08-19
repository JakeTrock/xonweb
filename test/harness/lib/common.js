'use strict';

const fs = require('fs');
const http = require('http');
const path = require('path');
const { spawn, execFileSync } = require('child_process');

const REPO = path.resolve(__dirname, '../../..');
const ARTIFACTS = path.join(REPO, 'test', 'artifacts');
const CURRENT_DIR = path.join(ARTIFACTS, 'current');
const STACK_FILE = path.join(CURRENT_DIR, 'stack.json');

function repoRoot() {
	return REPO;
}

function ensureDir(p) {
	fs.mkdirSync(p, { recursive: true });
	return p;
}

function readJson(file, fallback) {
	try {
		return JSON.parse(fs.readFileSync(file, 'utf8'));
	} catch (e) {
		return fallback;
	}
}

function writeJson(file, obj) {
	ensureDir(path.dirname(file));
	fs.writeFileSync(file, JSON.stringify(obj, null, 2) + '\n');
}

function newRunId() {
	const d = new Date();
	const pad = (n) => String(n).padStart(2, '0');
	return (
		d.getFullYear() +
		pad(d.getMonth() + 1) +
		pad(d.getDate()) +
		'-' +
		pad(d.getHours()) +
		pad(d.getMinutes()) +
		pad(d.getSeconds())
	);
}

function currentRun() {
	const stack = readJson(STACK_FILE, null);
	if (stack && stack.runId) return stack.runId;
	const marker = path.join(CURRENT_DIR, 'run.json');
	const run = readJson(marker, null);
	if (run && run.runId) return run.runId;
	const id = newRunId();
	ensureDir(CURRENT_DIR);
	writeJson(marker, { runId: id });
	return id;
}

function runDir(runId) {
	return ensureDir(path.join(ARTIFACTS, runId || currentRun()));
}

function clientDir(id, runId) {
	return ensureDir(path.join(runDir(runId), id || 'a'));
}

function clientSessionFile(id) {
	return path.join(CURRENT_DIR, 'clients', (id || 'a') + '.json');
}

function loadSession(id) {
	const s = readJson(clientSessionFile(id), null);
	if (!s) throw new Error('no client session for --id ' + (id || 'a') + ' (run client start first)');
	return s;
}

function saveSession(session) {
	writeJson(clientSessionFile(session.id), session);
}

function httpGet(url, timeoutMs) {
	return new Promise((resolve, reject) => {
		const req = http.get(url, { timeout: timeoutMs || 3000 }, (res) => {
			let data = '';
			res.setEncoding('utf8');
			res.on('data', (c) => { data += c; });
			res.on('end', () => resolve({ status: res.statusCode, body: data }));
		});
		req.on('timeout', () => { req.destroy(); reject(new Error('timeout ' + url)); });
		req.on('error', reject);
	});
}

function which(cmd) {
	try {
		return execFileSync('bash', ['-lc', 'command -v ' + JSON.stringify(cmd)], {
			encoding: 'utf8',
		}).trim();
	} catch (e) {
		return null;
	}
}

function findChromeInDir(dir) {
	if (!fs.existsSync(dir)) return null;
	const stack = [dir];
	while (stack.length) {
		const cur = stack.pop();
		let names;
		try { names = fs.readdirSync(cur); } catch (e) { continue; }
		for (const name of names) {
			const p = path.join(cur, name);
			let st;
			try { st = fs.statSync(p); } catch (e) { continue; }
			if (st.isDirectory()) {
				stack.push(p);
				continue;
			}
			if (name === 'chrome' || name === 'chromium' || name === 'chrome-headless-shell') {
				try { fs.accessSync(p, fs.constants.X_OK); return p; } catch (e) { /* skip */ }
			}
		}
	}
	return null;
}

function findChrome() {
	if (process.env.CHROME_PATH && fs.existsSync(process.env.CHROME_PATH))
		return process.env.CHROME_PATH;
	const bundled = findChromeInDir(path.join(REPO, 'test', 'browsers'));
	if (bundled) return bundled;
	const names = [
		'google-chrome',
		'google-chrome-stable',
		'chromium',
		'/usr/bin/google-chrome',
		'/usr/bin/chromium',
		'/snap/bin/chromium',
	];
	for (const n of names) {
		if (n.startsWith('/') && fs.existsSync(n)) {
			// Ubuntu's chromium-browser is often a snap stub — skip non-ELF wrappers later
			return n;
		}
		const w = which(n);
		if (w) return w;
	}
	throw new Error(
		'Chrome not found. Set CHROME_PATH or run:\n' +
		'  cd test && npx --yes @puppeteer/browsers install chrome@stable --path browsers'
	);
}

function parseArgs(argv) {
	const flags = { id: 'a', cdp: null, target: 'canvas' };
	const positional = [];
	for (let i = 0; i < argv.length; i++) {
		const a = argv[i];
		const next = () => argv[++i];
		if (a === '--id') flags.id = next();
		else if (a.startsWith('--id=')) flags.id = a.slice(5);
		else if (a === '--cdp') flags.cdp = parseInt(next(), 10);
		else if (a.startsWith('--cdp=')) flags.cdp = parseInt(a.slice(6), 10);
		else if (a === '--headed') flags.headed = true;
		else if (a === '--timeout') flags.timeout = parseFloat(next());
		else if (a.startsWith('--timeout=')) flags.timeout = parseFloat(a.slice(10));
		else if (a === '--stream') flags.stream = next();
		else if (a.startsWith('--stream=')) flags.stream = a.slice(9);
		else if (a === '--grep') flags.grep = next();
		else if (a.startsWith('--grep=')) flags.grep = a.slice(7);
		else if (a === '--tail') flags.tail = parseInt(next(), 10);
		else if (a.startsWith('--tail=')) flags.tail = parseInt(a.slice(7), 10);
		else if (a === '--since') flags.since = next();
		else if (a.startsWith('--since=')) flags.since = a.slice(8);
		else if (a === '--seconds') flags.seconds = parseFloat(next());
		else if (a.startsWith('--seconds=')) flags.seconds = parseFloat(a.slice(10));
		else if (a === '--hz') flags.hz = parseFloat(next());
		else if (a.startsWith('--hz=')) flags.hz = parseFloat(a.slice(5));
		else if (a === '--depth') flags.depth = parseInt(next(), 10);
		else if (a.startsWith('--depth=')) flags.depth = parseInt(a.slice(8), 10);
		else if (a === '--max-bytes') flags.maxBytes = parseInt(next(), 10);
		else if (a.startsWith('--max-bytes=')) flags.maxBytes = parseInt(a.slice(12), 10);
		else if (a === '--svc') flags.svc = next();
		else if (a.startsWith('--svc=')) flags.svc = a.slice(6);
		else if (a === '--canvas') flags.target = 'canvas';
		else if (a === '--page') flags.target = 'page';
		else if (a === '--ui') flags.target = 'ui';
		else if (a === '--dump') flags.dump = true;
		else if (a === '--force') flags.force = true;
		else if (a === '--map') flags.map = next();
		else if (a.startsWith('--map=')) flags.map = a.slice(6);
		else if (a.startsWith('--')) throw new Error('unknown flag ' + a);
		else positional.push(a);
	}
	return { flags, positional };
}

function parseSince(s) {
	if (s == null) return null;
	const m = String(s).match(/^(\d+(?:\.\d+)?)s?$/);
	if (m) return parseFloat(m[1]);
	return parseFloat(s);
}

function sleep(ms) {
	return new Promise((r) => setTimeout(r, ms));
}

function spawnLogged(cmd, args, logPath, cwd) {
	ensureDir(path.dirname(logPath));
	const fd = fs.openSync(logPath, 'a');
	const child = spawn(cmd, args, {
		cwd: cwd || REPO,
		detached: true,
		stdio: ['ignore', fd, fd],
		env: process.env,
	});
	child.unref();
	fs.closeSync(fd);
	return child;
}

function pidAlive(pid) {
	if (!pid) return false;
	try {
		process.kill(pid, 0);
		return true;
	} catch (e) {
		return false;
	}
}

function killPid(pid) {
	if (!pidAlive(pid)) return;
	try { process.kill(-pid, 'SIGTERM'); } catch (e) {
		try { process.kill(pid, 'SIGTERM'); } catch (e2) { /* gone */ }
	}
}

function printOut(value) {
	if (typeof value === 'string') process.stdout.write(value.endsWith('\n') ? value : value + '\n');
	else process.stdout.write(JSON.stringify(value, null, 2) + '\n');
}

module.exports = {
	REPO,
	ARTIFACTS,
	CURRENT_DIR,
	STACK_FILE,
	repoRoot,
	ensureDir,
	readJson,
	writeJson,
	newRunId,
	currentRun,
	runDir,
	clientDir,
	clientSessionFile,
	loadSession,
	saveSession,
	httpGet,
	findChrome,
	parseArgs,
	parseSince,
	sleep,
	spawnLogged,
	pidAlive,
	killPid,
	printOut,
};
