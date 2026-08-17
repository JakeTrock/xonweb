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
 * TCP bridge mode:
 *   ws://proxy:8081/?target=game.example.com:9260&proto=tcp
 *   WebSocket binary messages → length-prefixed TCP frames to target
 *   Length-prefixed TCP frames from target → WebSocket binary messages
 *   Use with tcp-relay.js on the remote server to bridge to a local UDP game server.
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
	}));
});

const wss = new WebSocket.Server({ server, handleProtocols: (protocols) => {
	const set = new Set(protocols);
	if (set.has('binary')) return 'binary';
	return protocols[0] || false;
}});

// Track active connections
const activeConnections = new Map();
let connId = 0;

// --- TCP framing helpers ---
// 4-byte big-endian length prefix + payload

function writeTcpFrame(socket, data) {
	const header = Buffer.allocUnsafe(4);
	header.writeUInt32BE(data.length, 0);
	socket.write(header);
	socket.write(data);
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

wss.on('connection', (ws, req) => {
	const connNum = ++connId;
	
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
	
	// Parse target host:port
	const targetParts = target.split(':');
	const targetHost = targetParts[0];
	const targetPort = parseInt(targetParts[1] || '26000', 10);
	
	if (!targetHost || isNaN(targetPort)) {
		console.error(`[Conn ${connNum}] Invalid target: ${target}`);
		ws.close(1008, 'Invalid target');
		return;
	}
	
	const modeStr = useTCP ? 'TCP' : 'UDP';
	console.log(`[Conn ${connNum}] New ${modeStr} connection from ${req.socket.remoteAddress} → ${targetHost}:${targetPort}`);
	
	// Buffer for data before WS is ready
	const dataBuffer = [];
	let transport = null;
	
	if (useTCP) {
		// --- TCP bridge mode ---
		transport = net.createConnection(targetPort, targetHost, () => {
			console.log(`[Conn ${connNum}] TCP connected to ${targetHost}:${targetPort}`);
			// Flush any buffered data
			while (dataBuffer.length > 0) {
				writeTcpFrame(transport, dataBuffer.shift());
			}
		});
		
		const onTcpMessage = function(payload) {
			if (ws.readyState === WebSocket.OPEN) {
				ws.send(payload, { binary: true }, (err) => {
					if (err) console.error(`[Conn ${connNum}] Error sending to browser: ${err.message}`);
				});
			} else {
				if (dataBuffer.length < 100) dataBuffer.push(payload);
			}
		};
		
		transport.on('data', createTcpFrameParser(onTcpMessage));
		
		transport.on('error', (err) => {
			console.error(`[Conn ${connNum}] TCP socket error: ${err.message}`);
		});
		
		transport.on('close', () => {
			console.log(`[Conn ${connNum}] TCP socket closed`);
		});
		
		// WebSocket → TCP
		ws.on('message', (data, isBinary) => {
			if (!isBinary) return;
			if (transport.writable) {
				writeTcpFrame(transport, Buffer.from(data));
			}
		});
		
	} else {
		// --- UDP mode (original) ---
		transport = dgram.createSocket('udp4');
		let udpReady = true;
		
		transport.on('message', (msg, rinfo) => {
			if (ws.readyState === WebSocket.OPEN) {
				ws.send(msg, { binary: true }, (err) => {
					if (err) console.error(`[Conn ${connNum}] Error sending to browser: ${err.message}`);
				});
			} else {
				if (dataBuffer.length < 100) dataBuffer.push(msg);
			}
		});
		
		transport.on('error', (err) => {
			console.error(`[Conn ${connNum}] UDP socket error: ${err.message}`);
		});
		
		transport.on('close', () => {
			console.log(`[Conn ${connNum}] UDP socket closed`);
		});
		
		// WebSocket → UDP
		ws.on('message', (data, isBinary) => {
			if (!isBinary) return;
			transport.send(data, 0, data.length, targetPort, targetHost, (err) => {
				if (err) console.error(`[Conn ${connNum}] Error sending UDP: ${err.message}`);
			});
		});
	}
	
	// Handle WebSocket open - flush any buffered data
	if (ws.readyState === WebSocket.OPEN) {
		while (dataBuffer.length > 0) {
			const data = dataBuffer.shift();
			if (useTCP && transport.writable) {
				writeTcpFrame(transport, data);
			} else if (!useTCP) {
				// For UDP, we can't replay easily since dataBuffer stores Buffers not {data,port,host}
				// This is fine — UDP data arriving before WS open is rare
			}
		}
	}
	
	// Handle WebSocket close
	ws.on('close', (code, reason) => {
		const reasonStr = reason ? reason.toString() : 'unknown';
		console.log(`[Conn ${connNum}] WebSocket closed (code: ${code}, reason: ${reasonStr})`);
		if (useTCP) {
			transport.destroy();
		} else {
			transport.close();
		}
		activeConnections.delete(connNum);
	});
	
	// Handle WebSocket error
	ws.on('error', (err) => {
		console.error(`[Conn ${connNum}] WebSocket error: ${err.message}`);
		if (useTCP) {
			transport.destroy();
		} else {
			transport.close();
		}
		activeConnections.delete(connNum);
	});
	
	activeConnections.set(connNum, {
		ws,
		transport,
		target: `${targetHost}:${targetPort}`,
		mode: modeStr,
		remoteAddress: req.socket.remoteAddress,
		connectedAt: new Date(),
	});
});

server.listen(PORT, '0.0.0.0', () => {
	console.log(`Xonotic WebSocket proxy running on port ${PORT}`);
	console.log(`Default target: ${DEFAULT_TARGET || 'none (must be specified in URL)'}`);
	console.log(`UDP mode:  ws://localhost:${PORT}/?target=host:port`);
	console.log(`TCP mode:  ws://localhost:${PORT}/?target=host:port&proto=tcp`);
	console.log(`Server list: http://localhost:${PORT}/slist`);
	console.log(`DNS resolve: http://localhost:${PORT}/resolve?host=hostname`);
	console.log(`Press Ctrl+C to stop`);
});

// Graceful shutdown
process.on('SIGINT', () => {
	console.log('\nShutting down...');
	for (const [id, conn] of activeConnections) {
		conn.ws.close(1001, 'Server shutting down');
		if (conn.mode === 'TCP') {
			conn.transport.destroy();
		} else {
			conn.transport.close();
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
			const duration = Math.round((new Date() - conn.connectedAt) / 1000);
			console.log(`  [${id}] ${conn.remoteAddress} → ${conn.target} (${conn.mode}, ${duration}s)`);
		}
	}
}, 60000);
