#!/usr/bin/env node
/**
 * Xonotic WebSocket Proxy Server
 * 
 * Bridges WebSocket connections from browser clients to game servers.
 * Supports both UDP (default) and TCP bridge modes.
 * 
 * Usage: node server.js [--port=8081] [--default-target=host:port]
 * 
 * UDP mode (default):
 *   ws://proxy:8081/?target=game.example.com:26000
 *   WebSocket binary messages → UDP datagrams to target
 *   UDP datagrams from target → WebSocket binary messages
 * 
 * TCP bridge mode (L7 fallback; prefer udp2raw/hop.js FakeTCP):
 *   ws://proxy:8081/?target=game.example.com:9260&proto=tcp
 *   WebSocket binary messages → length-prefixed TCP frames to target
 *   Length-prefixed TCP frames from target → WebSocket binary messages
 *   Use with tcp-relay.js only when a middlebox requires a real TCP stream.
 */

const dgram = require('dgram');
const net = require('net');
const http = require('http');
const dns = require('dns');
const url = require('url');
const WebSocket = require('ws');

// --- Xonotic master server list (from xonotic-common.cfg) ---
const MASTER_SERVERS = [
	{ host: 'dpm4.xonotic.xyz', port: 27777 },
	{ host: 'dpm6.xonotic.xyz', port: 27777 },
	{ host: 'master3.xonotic.org', port: 27950 },
	{ host: 'master4.xonotic.org', port: 42863 },
	{ host: 'master1.xonotic.org', port: 42863 },
	{ host: 'master2.xonotic.org', port: 27950 },
];
const GAMENAME = 'Xonotic';
const PROTOCOL_VERSION = 3;

// --- /slist: Query master servers and return JSON server list ---
function resolveHost(hostname) {
	return new Promise((resolve) => {
		dns.resolve4(hostname, (err, addresses) => {
			if (err || !addresses.length) resolve(null);
			else resolve(addresses[0]);
		});
	});
}

function queryMasterServer(ip, port) {
	return new Promise((resolve) => {
		const sock = dgram.createSocket('udp4');
		const servers = [];
		let done = false;
		let idleTimer = null;
		
		const finish = () => {
			if (done) return;
			done = true;
			clearTimeout(timeout);
			if (idleTimer) clearTimeout(idleTimer);
			try { sock.close(); } catch(e) {}
			resolve(servers);
		};
		
		const timeout = setTimeout(finish, 3000);
		
		sock.on('message', (msg, rinfo) => {
			// Parse getserversResponse (may come in multiple packets)
			const prefix = Buffer.from([0xff, 0xff, 0xff, 0xff]);
			const responseCmd = Buffer.concat([prefix, Buffer.from('getserversResponse')]);
			if (msg.length < responseCmd.length) return;
			if (!msg.slice(0, responseCmd.length).equals(responseCmd)) return;
			
			// After the response header, entries are \\ + 4 bytes IP + 2 bytes port (big-endian)
			let offset = responseCmd.length;
			while (offset + 6 <= msg.length) {
				if (msg[offset] !== 0x5c) { offset++; continue; } // skip non-backslash bytes
				offset++;
				if (offset + 6 > msg.length) break;
				const sip = msg.readUInt8(offset) + '.' + msg.readUInt8(offset+1) + '.' + msg.readUInt8(offset+2) + '.' + msg.readUInt8(offset+3);
				const sport = msg.readUInt16BE(offset + 4);
				offset += 6;
				if (sip === '0.0.0.0' && sport === 0) continue; // EOT marker
				if (sport === 0) continue;
				servers.push({ ip: sip, port: sport });
			}
			
			// Reset idle timer - close after 500ms of inactivity
			if (idleTimer) clearTimeout(idleTimer);
			idleTimer = setTimeout(finish, 500);
		});
		
		sock.on('error', finish);
		
		// Send getservers query
		const query = Buffer.concat([Buffer.from([0xff, 0xff, 0xff, 0xff]), Buffer.from('getservers ' + GAMENAME + ' ' + PROTOCOL_VERSION + ' empty full')]);
		sock.send(query, 0, query.length, port, ip, (err) => {
			if (err) finish();
		});
	});
}

function queryServerInfo(ip, port) {
	return new Promise((resolve) => {
		const sock = dgram.createSocket('udp4');
		let done = false;
		const startTime = Date.now();
		
		const timeout = setTimeout(() => {
			if (!done) { done = true; try { sock.close(); } catch(e) {} resolve(null); }
		}, 1500);
		
		sock.on('message', (msg, rinfo) => {
			// Parse infoResponse
			const prefix = Buffer.from([0xff, 0xff, 0xff, 0xff]);
			const responseCmd = Buffer.concat([prefix, Buffer.from('infoResponse\n')]);
			if (msg.length < responseCmd.length) return;
			if (!msg.slice(0, responseCmd.length).equals(responseCmd)) return;
			
			// Parse infostring (backslash-separated key-value pairs, starts with \)
			const infoStr = msg.slice(responseCmd.length).toString('latin1');
			const info = {};
			const parts = infoStr.split('\\');
			// Skip leading empty element from the initial backslash
			const start = (parts.length > 0 && parts[0] === '') ? 1 : 0;
			for (let i = start; i + 1 < parts.length; i += 2) {
				info[parts[i]] = parts[i + 1];
			}
			info._ping = Date.now() - startTime;
			
			if (!done) {
				done = true;
				clearTimeout(timeout);
				try { sock.close(); } catch(e) {}
				resolve(info);
			}
		});
		
		sock.on('error', () => { if (!done) { done = true; clearTimeout(timeout); try { sock.close(); } catch(e) {} resolve(null); } });
		
		// Send getinfo query
		const query = Buffer.concat([Buffer.from([0xff, 0xff, 0xff, 0xff]), Buffer.from('getinfo')]);
		sock.send(query, 0, query.length, port, ip, (err) => {
			if (err) { if (!done) { done = true; clearTimeout(timeout); try { sock.close(); } catch(e) {} resolve(null); } }
		});
	});
}

async function handleServerList(req, res) {
	try {
		// 1. Resolve all master server hostnames
		const masterIPs = [];
		for (const ms of MASTER_SERVERS) {
			const ip = await resolveHost(ms.host);
			if (ip) masterIPs.push({ ip, port: ms.port, name: ms.host });
		}
		
		if (masterIPs.length === 0) {
			res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
			res.end(JSON.stringify({ servers: [], error: 'No master servers resolved' }));
			return;
		}
		
		// 2. Query all master servers in parallel
		const masterResults = await Promise.all(masterIPs.map(ms => queryMasterServer(ms.ip, ms.port)));
		
		// 3. Deduplicate server list
		const serverMap = new Map();
		for (const servers of masterResults) {
			for (const s of servers) {
				const key = s.ip + ':' + s.port;
				if (!serverMap.has(key)) serverMap.set(key, s);
			}
		}
		
		// 4. Query info from each server (in parallel, but limit concurrency)
		const serverList = Array.from(serverMap.values());
		const BATCH_SIZE = 50;
		const results = [];
		
		for (let i = 0; i < serverList.length; i += BATCH_SIZE) {
			const batch = serverList.slice(i, i + BATCH_SIZE);
			const infos = await Promise.all(batch.map(s => queryServerInfo(s.ip, s.port)));
			for (let j = 0; j < batch.length; j++) {
				const info = infos[j];
				if (info && info.hostname) {
					results.push({
						ip: batch[j].ip,
						port: batch[j].port,
						address: batch[j].ip + ':' + batch[j].port,
						hostname: info.hostname || 'unnamed',
						map: info.mapname || 'unknown',
						players: parseInt(info.clients || '0', 10),
						maxplayers: parseInt(info.sv_maxclients || '0', 10),
						ping: info._ping || 0,
						game: info.game || '',
						mod: info.mod || '',
						qcstatus: info.qcstatus || '',
					});
				}
			}
		}
		
		// Sort by player count (descending), then by ping (ascending)
		results.sort((a, b) => b.players - a.players || a.ping - b.ping);
		
		res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
		res.end(JSON.stringify({ servers: results, count: results.length }));
	} catch (err) {
		res.writeHead(500, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
		res.end(JSON.stringify({ error: err.message }));
	}
}

// Parse command line args
const args = process.argv.slice(2);
let PORT = 8081;
let DEFAULT_TARGET = null;

for (const arg of args) {
	if (arg.startsWith('--port=')) {
		PORT = parseInt(arg.substring(7), 10);
	} else if (arg.startsWith('--default-target=')) {
		DEFAULT_TARGET = arg.substring(17);
	}
}

// Create HTTP server for health checks, /slist API, and WebSocket upgrade
const server = http.createServer((req, res) => {
	const parsedUrl = url.parse(req.url, true);
	
	// CORS headers for all responses
	res.setHeader('Access-Control-Allow-Origin', '*');
	res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
	res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
	
	if (req.method === 'OPTIONS') {
		res.writeHead(204);
		res.end();
		return;
	}
	
	if (parsedUrl.pathname === '/slist') {
		handleServerList(req, res);
		return;
	}

	if (parsedUrl.pathname === '/stats') {
		res.writeHead(200, { 'Content-Type': 'application/json' });
		res.end(JSON.stringify(collectStats()));
		return;
	}

	if (parsedUrl.pathname === '/getinfo') {
		const target = parsedUrl.query.addr || parsedUrl.query.target || '';
		const parts = String(target).split(':');
		const host = parts[0];
		const port = parseInt(parts[1] || '26000', 10);
		if (!host || isNaN(port)) {
			res.writeHead(400, { 'Content-Type': 'application/json' });
			res.end(JSON.stringify({ error: 'addr=host:port required' }));
			return;
		}
		queryServerInfo(host, port).then((info) => {
			res.writeHead(200, { 'Content-Type': 'application/json' });
			res.end(JSON.stringify(info || { error: 'timeout', address: host + ':' + port }));
		});
		return;
	}
	
	if (parsedUrl.pathname === '/resolve') {
		const host = parsedUrl.query.host;
		if (!host) {
			res.writeHead(400, { 'Content-Type': 'text/plain' });
			res.end('Missing host parameter');
			return;
		}
		dns.resolve4(host, (err, addresses) => {
			if (err || !addresses.length) {
				res.writeHead(404, { 'Content-Type': 'text/plain' });
				res.end('resolve failed');
			} else {
				res.writeHead(200, { 'Content-Type': 'text/plain' });
				res.end(addresses[0]);
			}
		});
		return;
	}
	
	res.writeHead(200, { 'Content-Type': 'application/json' });
	res.end(JSON.stringify({
		status: 'ok',
		service: 'xonotic-ws-proxy',
		connections: activeConnections.size,
		drops: totals.wsDrops + totals.udpDrops,
		uptimeMs: Date.now() - startedAt,
	}));
});

// Game packets are small and latency-sensitive. permessage-deflate and Nagle
// turn each datagram into extra CPU + 40ms delayed-ACK stalls.
const wss = new WebSocket.Server({
	server,
	perMessageDeflate: false,
	maxPayload: 65536,
	skipUTF8Validation: true,
	clientTracking: false,
	handleProtocols: (protocols) => {
		const set = new Set(protocols);
		if (set.has('binary')) return 'binary';
		return protocols[0] || false;
	},
});

function hardenTcpSocket(sock) {
	if (!sock) return;
	try { sock.setNoDelay(true); } catch (e) { /* ignore */ }
	try { sock.setKeepAlive(true, 10000); } catch (e) { /* ignore */ }
	try { sock.setTimeout(0); } catch (e) { /* ignore */ }
}

server.on('connection', hardenTcpSocket);
server.timeout = 0;
server.keepAliveTimeout = 0;
if (typeof server.headersTimeout === 'number') server.headersTimeout = 0;

function enlargeUdpBuffers(sock) {
	try { sock.setRecvBufferSize(4 * 1024 * 1024); } catch (e) { /* ignore */ }
	try { sock.setSendBufferSize(4 * 1024 * 1024); } catch (e) { /* ignore */ }
}

function ipv4Literal(host) {
	return /^\d{1,3}(?:\.\d{1,3}){3}$/.test(host || '');
}

// Track active connections
const activeConnections = new Map();
let connId = 0;
const startedAt = Date.now();
const totals = {
	wsToUdp: 0,
	udpToWs: 0,
	wsBytes: 0,
	udpBytes: 0,
	wsDrops: 0,
	udpDrops: 0,
};

// Drop rather than queue when the browser is already this far behind.
// ~128 KiB is a few hundred ms of typical Xonotic traffic; queuing more
// turns a hitch into multi-second jitter (UDP would have dropped).
const MAX_WS_BUFFERED = 128 * 1024;
const WS_PING_MS = 5000;

function ewmaUpdate(prev, sample, alpha) {
	if (prev == null || !isFinite(prev)) return sample;
	return prev + alpha * (sample - prev);
}

function collectStats() {
	const conns = [];
	for (const [id, conn] of activeConnections) {
		conns.push({
			id,
			target: conn.target,
			mode: conn.mode,
			remoteAddress: conn.remoteAddress,
			ageMs: Date.now() - conn.connectedAt,
			wsToUdp: conn.stats.wsToUdp,
			udpToWs: conn.stats.udpToWs,
			wsBytes: conn.stats.wsBytes,
			udpBytes: conn.stats.udpBytes,
			wsDrops: conn.stats.wsDrops,
			udpDrops: conn.stats.udpDrops,
			bufferedAmount: conn.ws && conn.ws.bufferedAmount || 0,
			wsRttMs: conn.stats.wsRttMs,
			udpInterarrivalMs: conn.stats.udpInterarrivalMs,
			wsInterarrivalMs: conn.stats.wsInterarrivalMs,
		});
	}
	return {
		service: 'xonotic-ws-proxy',
		uptimeMs: Date.now() - startedAt,
		connections: activeConnections.size,
		totals: Object.assign({}, totals),
		conns,
	};
}

// --- TCP framing helpers ---
// 4-byte big-endian length prefix + payload

function writeTcpFrame(socket, data) {
	const frame = Buffer.allocUnsafe(4 + data.length);
	frame.writeUInt32BE(data.length, 0);
	data.copy(frame, 4);
	socket.write(frame);
}

function createTcpFrameParser(onMessage) {
	let buffer = Buffer.alloc(0);
	return function onData(chunk) {
		buffer = Buffer.concat([buffer, chunk]);
		while (buffer.length >= 4) {
			const msgLen = buffer.readUInt32BE(0);
			if (msgLen > 1048576) { // 1MB max
				console.error('TCP frame too large: ' + msgLen);
				buffer = Buffer.alloc(0);
				return;
			}
			if (buffer.length < 4 + msgLen) break; // need more data
			const payload = buffer.slice(4, 4 + msgLen);
			buffer = buffer.slice(4 + msgLen);
			onMessage(payload);
		}
	};
}

function sendToBrowser(conn, payload) {
	const ws = conn.ws;
	if (!ws || ws.readyState !== WebSocket.OPEN) {
		conn.stats.wsDrops++;
		totals.wsDrops++;
		return false;
	}
	if (ws.bufferedAmount > MAX_WS_BUFFERED) {
		conn.stats.wsDrops++;
		totals.wsDrops++;
		if ((conn.stats.wsDrops % 50) === 1) {
			console.error(`[Conn ${conn.id}] dropping to browser (bufferedAmount=${ws.bufferedAmount}, drops=${conn.stats.wsDrops})`);
		}
		return false;
	}
	try {
		ws.send(payload, { binary: true, compress: false });
		return true;
	} catch (err) {
		conn.stats.wsDrops++;
		totals.wsDrops++;
		return false;
	}
}

function noteInterarrival(conn, now, which) {
	const prevKey = which === 'udp' ? 'lastUdpAt' : 'lastWsAt';
	const ewmaKey = which === 'udp' ? 'udpInterarrivalMs' : 'wsInterarrivalMs';
	const prev = conn.stats[prevKey];
	if (prev) {
		const dt = now - prev;
		if (dt > 0 && dt < 2000)
			conn.stats[ewmaKey] = ewmaUpdate(conn.stats[ewmaKey], dt, 0.2);
	}
	conn.stats[prevKey] = now;
}

wss.on('connection', (ws, req) => {
	const connNum = ++connId;

	hardenTcpSocket(req.socket);
	hardenTcpSocket(ws._socket);

	// Parse target and protocol from query string
	const parsedUrl = url.parse(req.url, true);
	const target = parsedUrl.query.target || DEFAULT_TARGET;
	const proto = (parsedUrl.query.proto || 'udp').toLowerCase();
	const useTCP = (proto === 'tcp');

	if (!target) {
		console.error(`[Conn ${connNum}] No target specified in connection URL`);
		ws.close(1008, 'No target specified');
		return;
	}

	// Parse target host:port (IPv4 only)
	const targetParts = String(target).split(':');
	const targetHost = targetParts[0];
	const targetPort = parseInt(targetParts[1] || '26000', 10);

	if (!targetHost || isNaN(targetPort)) {
		console.error(`[Conn ${connNum}] Invalid target: ${target}`);
		ws.close(1008, 'Invalid target');
		return;
	}

	const modeStr = useTCP ? 'TCP' : 'UDP';
	console.log(`[Conn ${connNum}] New ${modeStr} connection from ${req.socket.remoteAddress} → ${targetHost}:${targetPort}`);

	const conn = {
		id: connNum,
		ws,
		transport: null,
		target: `${targetHost}:${targetPort}`,
		mode: modeStr,
		remoteAddress: req.socket.remoteAddress,
		connectedAt: Date.now(),
		udpDest: { host: targetHost, port: targetPort },
		pingTimer: null,
		stats: {
			wsToUdp: 0,
			udpToWs: 0,
			wsBytes: 0,
			udpBytes: 0,
			wsDrops: 0,
			udpDrops: 0,
			wsRttMs: null,
			udpInterarrivalMs: null,
			wsInterarrivalMs: null,
			lastUdpAt: 0,
			lastWsAt: 0,
			lastPingAt: 0,
		},
	};

	function closeTransport() {
		if (!conn.transport) return;
		try {
			if (useTCP) conn.transport.destroy();
			else conn.transport.close();
		} catch (e) { /* ignore */ }
		conn.transport = null;
	}

	function teardown() {
		if (conn.pingTimer) {
			clearInterval(conn.pingTimer);
			conn.pingTimer = null;
		}
		closeTransport();
		activeConnections.delete(connNum);
	}

	if (useTCP) {
		const transport = net.createConnection({
			port: targetPort,
			host: targetHost,
			noDelay: true,
			keepAlive: true,
		}, () => {
			hardenTcpSocket(transport);
			console.log(`[Conn ${connNum}] TCP connected to ${targetHost}:${targetPort}`);
		});
		conn.transport = transport;

		transport.on('data', createTcpFrameParser((payload) => {
			const now = Date.now();
			noteInterarrival(conn, now, 'udp');
			if (sendToBrowser(conn, payload)) {
				conn.stats.udpToWs++;
				conn.stats.udpBytes += payload.length;
				totals.udpToWs++;
				totals.udpBytes += payload.length;
			}
		}));

		transport.on('error', (err) => {
			console.error(`[Conn ${connNum}] TCP socket error: ${err.message}`);
		});

		transport.on('close', () => {
			console.log(`[Conn ${connNum}] TCP socket closed`);
		});

		ws.on('message', (data, isBinary) => {
			if (!isBinary) return;
			const buf = Buffer.isBuffer(data) ? data : Buffer.from(data);
			noteInterarrival(conn, Date.now(), 'ws');
			conn.stats.wsToUdp++;
			conn.stats.wsBytes += buf.length;
			totals.wsToUdp++;
			totals.wsBytes += buf.length;
			if (transport.writable) writeTcpFrame(transport, buf);
			else {
				conn.stats.udpDrops++;
				totals.udpDrops++;
			}
		});
	} else {
		const transport = dgram.createSocket({ type: 'udp4', reuseAddr: false });
		conn.transport = transport;
		enlargeUdpBuffers(transport);

		let udpBound = false;
		const pendingUdp = [];

		const sendUdpNow = (buf) => {
			try {
				transport.send(buf, conn.udpDest.port, conn.udpDest.host);
			} catch (err) {
				conn.stats.udpDrops++;
				totals.udpDrops++;
				if ((conn.stats.udpDrops % 50) === 1)
					console.error(`[Conn ${connNum}] UDP send error: ${err.message}`);
			}
		};

		const sendUdp = (buf) => {
			if (!udpBound) {
				if (pendingUdp.length < 16) pendingUdp.push(Buffer.from(buf));
				else {
					conn.stats.udpDrops++;
					totals.udpDrops++;
				}
				return;
			}
			sendUdpNow(buf);
		};

		transport.on('message', (msg, rinfo) => {
			if (rinfo && (rinfo.port !== conn.udpDest.port || rinfo.address !== conn.udpDest.host))
				return;
			const now = Date.now();
			noteInterarrival(conn, now, 'udp');
			if (sendToBrowser(conn, msg)) {
				conn.stats.udpToWs++;
				conn.stats.udpBytes += msg.length;
				totals.udpToWs++;
				totals.udpBytes += msg.length;
			}
		});

		transport.on('error', (err) => {
			console.error(`[Conn ${connNum}] UDP socket error: ${err.message}`);
		});

		transport.on('close', () => {
			console.log(`[Conn ${connNum}] UDP socket closed`);
		});

		// Bind immediately so the ephemeral source port is stable. Do not
		// socket.connect(): a connected UDP socket turns ICMP errors into
		// 'error' events and can drop replies from the dedicated.
		const setDestHost = (host) => {
			conn.udpDest.host = host;
			conn.target = `${host}:${targetPort}`;
		};
		if (ipv4Literal(targetHost))
			setDestHost(targetHost);
		else {
			dns.lookup(targetHost, { family: 4 }, (err, address) => {
				if (err || !address) {
					console.error(`[Conn ${connNum}] DNS lookup failed for ${targetHost}: ${err ? err.message : 'no A record'}`);
					return;
				}
				setDestHost(address);
			});
		}

		transport.bind(0, () => {
			udpBound = true;
			enlargeUdpBuffers(transport);
			while (pendingUdp.length) sendUdpNow(pendingUdp.shift());
		});

		ws.on('message', (data, isBinary) => {
			if (!isBinary) return;
			const buf = Buffer.isBuffer(data) ? data : Buffer.from(data);
			noteInterarrival(conn, Date.now(), 'ws');
			conn.stats.wsToUdp++;
			conn.stats.wsBytes += buf.length;
			totals.wsToUdp++;
			totals.wsBytes += buf.length;
			sendUdp(buf);
		});
	}

	ws.on('pong', () => {
		if (conn.stats.lastPingAt)
			conn.stats.wsRttMs = Date.now() - conn.stats.lastPingAt;
	});

	conn.pingTimer = setInterval(() => {
		if (ws.readyState !== WebSocket.OPEN) return;
		conn.stats.lastPingAt = Date.now();
		try { ws.ping(); } catch (e) { /* ignore */ }
	}, WS_PING_MS);

	ws.on('close', (code, reason) => {
		const reasonStr = reason ? reason.toString() : 'unknown';
		console.log(`[Conn ${connNum}] WebSocket closed (code: ${code}, reason: ${reasonStr})`);
		teardown();
	});

	ws.on('error', (err) => {
		console.error(`[Conn ${connNum}] WebSocket error: ${err.message}`);
		teardown();
	});

	activeConnections.set(connNum, conn);
});

server.listen(PORT, '0.0.0.0', () => {
	console.log(`Xonotic WebSocket proxy running on port ${PORT}`);
	console.log(`Default target: ${DEFAULT_TARGET || 'none (must be specified in URL)'}`);
	console.log(`UDP mode:  ws://localhost:${PORT}/?target=host:port`);
	console.log(`TCP mode:  ws://localhost:${PORT}/?target=host:port&proto=tcp`);
	console.log(`Server list: http://localhost:${PORT}/slist`);
	console.log(`Stats:       http://localhost:${PORT}/stats`);
	console.log(`DNS resolve: http://localhost:${PORT}/resolve?host=hostname`);
	console.log(`Press Ctrl+C to stop`);
});

// Graceful shutdown
process.on('SIGINT', () => {
	console.log('\nShutting down...');
	for (const [id, conn] of activeConnections) {
		conn.ws.close(1001, 'Server shutting down');
		if (conn.pingTimer) {
			clearInterval(conn.pingTimer);
			conn.pingTimer = null;
		}
		if (conn.mode === 'TCP') {
			if (conn.transport) conn.transport.destroy();
		} else {
			if (conn.transport) conn.transport.close();
		}
	}
	server.close();
	process.exit(0);
});

// Log connection stats every 60 seconds
setInterval(() => {
	if (activeConnections.size > 0) {
		console.log(`Active connections: ${activeConnections.size}`);
		for (const [id, conn] of activeConnections) {
			const duration = Math.round((Date.now() - conn.connectedAt) / 1000);
			console.log(`  [${id}] ${conn.remoteAddress} → ${conn.target} (${conn.mode}, ${duration}s, ws→udp ${conn.stats.wsToUdp}, udp→ws ${conn.stats.udpToWs}, drops ${conn.stats.wsDrops + conn.stats.udpDrops}, buf ${conn.ws.bufferedAmount || 0})`);
		}
	}
}, 60000);
