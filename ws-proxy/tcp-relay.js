#!/usr/bin/env node
/**
 * Xonotic TCP-to-UDP Relay
 * 
 * Runs on a remote server alongside the game server. Listens for TCP
 * connections (with length-prefix framing) from the WS proxy and forwards
 * each framed message as a UDP datagram to the local game server, and vice versa.
 * 
 * Architecture:
 *   Browser ←─WS─→ WS Proxy ←─TCP framed─→ tcp-relay.js ←─UDP─→ Game Server
 * 
 * Usage: node tcp-relay.js --listen 0.0.0.0:9260 --target 127.0.0.1:26000
 * 
 * Framing protocol: 4-byte big-endian length prefix + payload
 */

const net = require('net');
const dgram = require('dgram');

// Parse command line args
const args = process.argv.slice(2);
let listenAddr = '0.0.0.0';
let listenPort = 9260;
let targetHost = '127.0.0.1';
let targetPort = 26000;

for (const arg of args) {
	if (arg.startsWith('--listen=')) {
		const parts = arg.substring(9).split(':');
		listenAddr = parts[0] || '0.0.0.0';
		listenPort = parseInt(parts[1] || '9260', 10);
	} else if (arg.startsWith('--target=')) {
		const parts = arg.substring(9).split(':');
		targetHost = parts[0] || '127.0.0.1';
		targetPort = parseInt(parts[1] || '26000', 10);
	}
}

let connId = 0;

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
			if (msgLen > 1048576) {
				console.error('TCP frame too large: ' + msgLen);
				buffer = Buffer.alloc(0);
				return;
			}
			if (buffer.length < 4 + msgLen) break;
			const payload = buffer.slice(4, 4 + msgLen);
			buffer = buffer.slice(4 + msgLen);
			onMessage(payload);
		}
	};
}

const tcpServer = net.createServer((tcpSocket) => {
	const num = ++connId;
	console.log(`[Relay ${num}] TCP connection from ${tcpSocket.remoteAddress}:${tcpSocket.remotePort}`);

	const udpSocket = dgram.createSocket('udp4');
	let udpTarget = { host: targetHost, port: targetPort };

	// TCP → UDP
	tcpSocket.on('data', createTcpFrameParser((payload) => {
		udpSocket.send(payload, 0, payload.length, udpTarget.port, udpTarget.host, (err) => {
			if (err) console.error(`[Relay ${num}] UDP send error: ${err.message}`);
		});
	}));

	// UDP → TCP (framed)
	udpSocket.on('message', (msg, rinfo) => {
		// Remember who the game server is (first packet from target)
		if (rinfo.address === udpTarget.host && rinfo.port === udpTarget.port) {
			if (tcpSocket.writable) {
				writeTcpFrame(tcpSocket, msg);
			}
		}
	});

	udpSocket.on('error', (err) => {
		console.error(`[Relay ${num}] UDP socket error: ${err.message}`);
	});

	tcpSocket.on('error', (err) => {
		console.error(`[Relay ${num}] TCP socket error: ${err.message}`);
	});

	tcpSocket.on('close', () => {
		console.log(`[Relay ${num}] TCP connection closed`);
		udpSocket.close();
	});
});

tcpServer.listen(listenPort, listenAddr, () => {
	console.log(`Xonotic TCP-to-UDP relay listening on ${listenAddr}:${listenPort}`);
	console.log(`Forwarding to UDP ${targetHost}:${targetPort}`);
	console.log(`Press Ctrl+C to stop`);
});

process.on('SIGINT', () => {
	console.log('\nShutting down...');
	tcpServer.close();
	process.exit(0);
});
