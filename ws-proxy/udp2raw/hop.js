#!/usr/bin/env node
'use strict';

/**
 * Fetch and run wangyu-/udp2raw as the FakeTCP hop in front of a
 * dedicated server. The WASM client still speaks WebSocket ↔ UDP;
 * this process sits *after* ws-proxy/server.js (or instead of a
 * direct UDP path when an ISP blocks UDP).
 *
 *   Browser ←WS→ server.js ←UDP→ udp2raw client ←FakeTCP→ udp2raw server ←UDP→ dedicated
 */

const crypto = require('crypto');
const fs = require('fs');
const https = require('https');
const path = require('path');
const { spawn, execFileSync } = require('child_process');

const RELEASE = {
	tag: '20230206.0',
	url: 'https://github.com/wangyu-/udp2raw/releases/download/20230206.0/udp2raw_binaries.tar.gz',
	sha256: '503cf5781aa97e50b4954c6bc4622c3ea6be02f6a35def4bb3b3eaf95bd2c7e8',
	repo: 'https://github.com/wangyu-/udp2raw',
	license: 'MIT',
};

const DEFAULTS = {
	serverListen: '0.0.0.0:4096',
	serverTarget: '127.0.0.1:26000',
	clientListen: '127.0.0.1:26001',
	clientRemote: '127.0.0.1:4096',
	key: process.env.UDP2RAW_KEY || 'xonweb-dev',
	cipher: process.env.UDP2RAW_CIPHER || 'xor',
	auth: process.env.UDP2RAW_AUTH || 'simple',
	udpPort: 26001,
	faketcpPort: 4096,
};

const DIR = __dirname;
const TAR = path.join(DIR, 'udp2raw_binaries.tar.gz');
const BIN_DIR = path.join(DIR, 'bin');
const BIN = path.join(BIN_DIR, 'udp2raw');
const STAMP = path.join(BIN_DIR, 'VERSION');

function assetName() {
	const arch = process.arch;
	if (arch === 'x64') return 'udp2raw_amd64';
	if (arch === 'ia32') return 'udp2raw_x86';
	if (arch === 'arm') return 'udp2raw_arm';
	throw new Error(
		'no prebuilt udp2raw for arch ' + arch + ' in ' + RELEASE.tag +
		' (linux amd64 is the supported fetch). Build from ' + RELEASE.repo
	);
}

function fileSha256(p) {
	return crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');
}

function download(url, dest) {
	return new Promise((resolve, reject) => {
		const tmp = dest + '.part';
		const go = (u, n) => {
			if (n > 8) return reject(new Error('too many redirects'));
			https.get(u, {
				headers: { 'User-Agent': 'xonweb-udp2raw-fetch', Accept: '*/*' },
			}, (res) => {
				if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
					res.resume();
					const next = res.headers.location.startsWith('http')
						? res.headers.location
						: new URL(res.headers.location, u).href;
					return go(next, n + 1);
				}
				if (res.statusCode !== 200) {
					res.resume();
					return reject(new Error('download HTTP ' + res.statusCode + ' for ' + u));
				}
				const out = fs.createWriteStream(tmp);
				res.pipe(out);
				out.on('finish', () => out.close((err) => {
					if (err) return reject(err);
					fs.renameSync(tmp, dest);
					resolve();
				}));
				out.on('error', reject);
			}).on('error', reject);
		};
		go(url, 0);
	});
}

async function fetchBin() {
	fs.mkdirSync(BIN_DIR, { recursive: true });
	if (fs.existsSync(BIN) && fs.existsSync(STAMP) && fs.readFileSync(STAMP, 'utf8').trim() === RELEASE.tag)
		return BIN;
	process.stderr.write('fetching udp2raw ' + RELEASE.tag + '\n');
	if (!fs.existsSync(TAR) || fileSha256(TAR) !== RELEASE.sha256)
		await download(RELEASE.url, TAR);
	const got = fileSha256(TAR);
	if (got !== RELEASE.sha256)
		throw new Error('udp2raw tarball sha256 mismatch: ' + got);
	const name = assetName();
	execFileSync('tar', ['-xzf', TAR, '-C', BIN_DIR, name], { stdio: 'inherit' });
	const extracted = path.join(BIN_DIR, name);
	fs.renameSync(extracted, BIN);
	fs.chmodSync(BIN, 0o755);
	fs.writeFileSync(STAMP, RELEASE.tag + '\n');
	return BIN;
}

function canSudo() {
	try {
		execFileSync('sudo', ['-n', 'true'], { stdio: 'ignore' });
		return true;
	} catch (e) {
		return false;
	}
}

function parseHopArgs(argv) {
	const flags = {};
	const positional = [];
	for (let i = 0; i < argv.length; i++) {
		const a = argv[i];
		const next = () => argv[++i];
		if (a === '--listen') flags.listen = next();
		else if (a.startsWith('--listen=')) flags.listen = a.slice(9);
		else if (a === '--target') flags.target = next();
		else if (a.startsWith('--target=')) flags.target = a.slice(9);
		else if (a === '--remote') flags.remote = next();
		else if (a.startsWith('--remote=')) flags.remote = a.slice(9);
		else if (a === '--key') flags.key = next();
		else if (a.startsWith('--key=')) flags.key = a.slice(6);
		else if (a === '--raw-mode') flags.rawMode = next();
		else if (a.startsWith('--raw-mode=')) flags.rawMode = a.slice(11);
		else if (a === '--cipher-mode') flags.cipher = next();
		else if (a.startsWith('--cipher-mode=')) flags.cipher = a.slice(14);
		else if (a === '--auth-mode') flags.auth = next();
		else if (a.startsWith('--auth-mode=')) flags.auth = a.slice(12);
		else if (a.startsWith('--')) throw new Error('unknown flag ' + a);
		else positional.push(a);
	}
	return { flags, positional };
}

function chooseRawMode(override) {
	if (override) return override;
	if (process.getuid && process.getuid() === 0) return 'faketcp';
	if (canSudo()) return 'faketcp';
	return 'easy-faketcp';
}

function udp2rawArgs(role, flags) {
	const rawMode = chooseRawMode(flags.rawMode);
	const key = flags.key || DEFAULTS.key;
	const cipher = flags.cipher || DEFAULTS.cipher;
	const auth = flags.auth || DEFAULTS.auth;
	const listen = flags.listen || (role === 'server' ? DEFAULTS.serverListen : DEFAULTS.clientListen);
	const remote = role === 'server'
		? (flags.target || DEFAULTS.serverTarget)
		: (flags.remote || flags.target || DEFAULTS.clientRemote);
	const args = [
		role === 'server' ? '-s' : '-c',
		'-l', listen,
		'-r', remote,
		'-k', key,
		'--raw-mode', rawMode,
		'--cipher-mode', cipher,
		'--auth-mode', auth,
		'--disable-anti-replay',
		'--log-level', '4',
		'--disable-color',
	];
	if (rawMode === 'faketcp') args.push('-a');
	return { args, rawMode, listen, remote, key };
}

function spawnUdp2raw(udpArgs) {
	if (!fs.existsSync(BIN))
		throw new Error('missing ' + BIN + ' — run: node ws-proxy/udp2raw/hop.js fetch');
	const rawMode = udpArgs.includes('faketcp') && !udpArgs.includes('easy-faketcp');
	const needSudo = rawMode && process.getuid && process.getuid() !== 0;
	let cmd = BIN;
	let cmdArgs = udpArgs;
	if (needSudo) {
		if (!canSudo())
			throw new Error('faketcp needs root/CAP_NET_RAW (sudo -n). Use --raw-mode=easy-faketcp for a no-root loopback test.');
		cmd = 'sudo';
		cmdArgs = ['-n', '--', BIN].concat(udpArgs);
	}
	const child = spawn(cmd, cmdArgs, { stdio: 'inherit' });
	const stop = () => {
		try { child.kill('SIGTERM'); } catch (e) { /* ignore */ }
	};
	process.on('SIGTERM', stop);
	process.on('SIGINT', stop);
	child.on('exit', (code, signal) => {
		if (signal) process.kill(process.pid, signal);
		process.exit(code || 0);
	});
	return child;
}

async function main() {
	const { flags, positional } = parseHopArgs(process.argv.slice(2));
	const cmd = positional[0];
	if (!cmd || cmd === 'help' || cmd === '-h') {
		process.stderr.write(
			'Usage: ws-proxy/udp2raw/hop.js fetch|server|client|bin\n' +
			'  server [--listen 0.0.0.0:4096] [--target 127.0.0.1:26000]\n' +
			'  client [--listen 127.0.0.1:26001] [--remote host:4096]\n' +
			'  --raw-mode faketcp|easy-faketcp   (default: faketcp if sudo -n works)\n' +
			'  --key, --cipher-mode, --auth-mode\n'
		);
		process.exit(cmd ? 0 : 2);
	}
	if (cmd === 'fetch') {
		const p = await fetchBin();
		process.stdout.write(JSON.stringify({ ok: true, bin: p, tag: RELEASE.tag, asset: assetName() }, null, 2) + '\n');
		return;
	}
	if (cmd === 'bin') {
		process.stdout.write(BIN + '\n');
		return;
	}
	if (cmd === 'server' || cmd === 'client') {
		await fetchBin();
		const spec = udp2rawArgs(cmd, flags);
		if (spec.rawMode === 'easy-faketcp')
			process.stderr.write('udp2raw raw-mode=easy-faketcp (no iptables). Use faketcp -a on a real UDP-blocked path.\n');
		process.stderr.write(
			'udp2raw ' + cmd + ' ' + spec.listen + ' → ' + spec.remote +
			' raw=' + spec.rawMode + '\n'
		);
		spawnUdp2raw(spec.args);
		return;
	}
	throw new Error('unknown command ' + cmd);
}

if (require.main === module) {
	main().catch((err) => {
		process.stderr.write(err.message + '\n');
		process.exit(1);
	});
}

module.exports = {
	RELEASE,
	DEFAULTS,
	BIN,
	fetchBin,
	udp2rawArgs,
	chooseRawMode,
	canSudo,
};
