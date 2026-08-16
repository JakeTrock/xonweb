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
const url = require('url');
const WebSocket = require('ws');

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

// Create HTTP server for health checks and WebSocket upgrade
const server = http.createServer((req, res) => {
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
