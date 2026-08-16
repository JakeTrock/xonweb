#!/usr/bin/env node
/**
 * Xonotic WebSocket-to-UDP Proxy Server
 * 
 * Bridges WebSocket connections from browser clients to UDP game servers.
 * Each WebSocket connection creates a UDP socket that relays datagrams to
 * the target game server specified in the connection URL query string.
 * 
 * Usage: node server.js [--port=8081] [--default-target=host:port]
 * 
 * Browser client connects to: ws://proxy:8081/?target=game.example.com:26000
 * The proxy creates a UDP socket and relays:
 *   - WebSocket binary messages → UDP datagrams to target
 *   - UDP datagrams from target → WebSocket binary messages
 */

const dgram = require('dgram');
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
	// Accept any requested protocol (engine sends 'binary')
	const set = new Set(protocols);
	if (set.has('binary')) return 'binary';
	return protocols[0] || false;
}});

// Track active connections
const activeConnections = new Map();
let connId = 0;

wss.on('connection', (ws, req) => {
	const connNum = ++connId;
	
	// Parse target from query string
	const parsedUrl = url.parse(req.url, true);
	const target = parsedUrl.query.target || DEFAULT_TARGET;
	
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
	
	console.log(`[Conn ${connNum}] New connection from ${req.socket.remoteAddress} → ${targetHost}:${targetPort}`);
	
	// Create UDP socket for this connection
	const udpSocket = dgram.createSocket('udp4');
	let udpReady = true;
	
	// Buffer for UDP data before WS is ready
	const udpBuffer = [];
	
	// Handle UDP messages from game server → send to browser via WebSocket
	udpSocket.on('message', (msg, rinfo) => {
		if (ws.readyState === WebSocket.OPEN) {
			ws.send(msg, { binary: true }, (err) => {
				if (err) {
					console.error(`[Conn ${connNum}] Error sending to browser: ${err.message}`);
				}
			});
		} else {
			// Buffer if WS not yet open
			if (udpBuffer.length < 100) {
				udpBuffer.push(msg);
			}
		}
	});
	
	udpSocket.on('error', (err) => {
		console.error(`[Conn ${connNum}] UDP socket error: ${err.message}`);
	});
	
	udpSocket.on('close', () => {
		console.log(`[Conn ${connNum}] UDP socket closed`);
	});
	
	// Handle WebSocket messages from browser → send to game server via UDP
	ws.on('message', (data, isBinary) => {
		if (!isBinary) {
			console.warn(`[Conn ${connNum}] Received non-binary message, ignoring`);
			return;
		}
		
		// Send as UDP datagram to the game server
		udpSocket.send(data, 0, data.length, targetPort, targetHost, (err) => {
			if (err) {
				console.error(`[Conn ${connNum}] Error sending UDP to ${targetHost}:${targetPort}: ${err.message}`);
			}
		});
	});
	
	// Handle WebSocket open - flush any buffered UDP data
	ws.on('open', () => {
		console.log(`[Conn ${connNum}] WebSocket open, flushing ${udpBuffer.length} buffered packets`);
		while (udpBuffer.length > 0) {
			ws.send(udpBuffer.shift(), { binary: true });
		}
	});
	
	// Handle WebSocket close
	ws.on('close', (code, reason) => {
		const reasonStr = reason ? reason.toString() : 'unknown';
		console.log(`[Conn ${connNum}] WebSocket closed (code: ${code}, reason: ${reasonStr})`);
		udpSocket.close();
		activeConnections.delete(connNum);
	});
	
	// Handle WebSocket error
	ws.on('error', (err) => {
		console.error(`[Conn ${connNum}] WebSocket error: ${err.message}`);
		udpSocket.close();
		activeConnections.delete(connNum);
	});
	
	// Flush buffer when WS is already open (connection event means it's open)
	if (ws.readyState === WebSocket.OPEN) {
		while (udpBuffer.length > 0) {
			ws.send(udpBuffer.shift(), { binary: true });
		}
	}
	
	activeConnections.set(connNum, {
		ws,
		udpSocket,
		target: `${targetHost}:${targetPort}`,
		remoteAddress: req.socket.remoteAddress,
		connectedAt: new Date(),
	});
});

server.listen(PORT, '0.0.0.0', () => {
	console.log(`Xonotic WebSocket-to-UDP proxy running on port ${PORT}`);
	console.log(`Default target: ${DEFAULT_TARGET || 'none (must be specified in URL)'}`);
	console.log(`Usage: ws://localhost:${PORT}/?target=game.example.com:26000`);
	console.log(`Press Ctrl+C to stop`);
});

// Graceful shutdown
process.on('SIGINT', () => {
	console.log('\nShutting down...');
	for (const [id, conn] of activeConnections) {
		conn.ws.close(1001, 'Server shutting down');
		conn.udpSocket.close();
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
			console.log(`  [${id}] ${conn.remoteAddress} → ${conn.target} (${duration}s)`);
		}
	}
}, 60000);
