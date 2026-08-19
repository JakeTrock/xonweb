'use strict';

const http = require('http');
const WebSocket = require('ws');

class Cdp {
	constructor(ws) {
		this.ws = ws;
		this.nextId = 1;
		this.pending = new Map();
		this.ws.on('message', (data) => {
			let msg;
			try { msg = JSON.parse(data.toString()); } catch (e) { return; }
			if (msg.id == null) return;
			const p = this.pending.get(msg.id);
			if (!p) return;
			this.pending.delete(msg.id);
			if (msg.error) p.reject(new Error(msg.error.message || JSON.stringify(msg.error)));
			else p.resolve(msg.result);
		});
	}

	send(method, params, timeoutMs) {
		const id = this.nextId++;
		const ms = timeoutMs || 20000;
		return new Promise((resolve, reject) => {
			const timer = setTimeout(() => {
				this.pending.delete(id);
				reject(new Error('CDP timeout ' + method + ' after ' + ms + 'ms'));
			}, ms);
			this.pending.set(id, {
				resolve: (v) => { clearTimeout(timer); resolve(v); },
				reject: (e) => { clearTimeout(timer); reject(e); },
			});
			this.ws.send(JSON.stringify({ id, method, params: params || {} }));
		});
	}

	async evaluate(expression, awaitPromise) {
		const result = await this.send('Runtime.evaluate', {
			expression,
			returnByValue: true,
			awaitPromise: awaitPromise !== false,
		});
		if (result.exceptionDetails) {
			const d = result.exceptionDetails;
			const text = (d.exception && (d.exception.description || d.exception.value)) || d.text || 'evaluate failed';
			throw new Error(String(text));
		}
		if (!result.result) return undefined;
		if (result.result.type === 'undefined') return undefined;
		return result.result.value;
	}

	async screenshot(opts) {
		const params = { format: 'png', fromSurface: true };
		if (opts && opts.clip) params.clip = opts.clip;
		const result = await this.send('Page.captureScreenshot', params);
		return Buffer.from(result.data, 'base64');
	}

	close() {
		try { this.ws.close(); } catch (e) { /* ignore */ }
	}
}

function httpGetJson(url) {
	return new Promise((resolve, reject) => {
		const req = http.get(url, { timeout: 3000 }, (res) => {
			let data = '';
			res.setEncoding('utf8');
			res.on('data', (c) => { data += c; });
			res.on('end', () => {
				try { resolve(JSON.parse(data)); }
				catch (e) { reject(new Error('bad JSON from ' + url + ': ' + data.slice(0, 200))); }
			});
		});
		req.on('timeout', () => { req.destroy(); reject(new Error('timeout ' + url)); });
		req.on('error', reject);
	});
}

async function waitForCdp(port, timeoutMs) {
	const deadline = Date.now() + (timeoutMs || 20000);
	let last = null;
	while (Date.now() < deadline) {
		try {
			const list = await httpGetJson('http://127.0.0.1:' + port + '/json/list');
			if (Array.isArray(list) && list.length) return list;
		} catch (e) {
			last = e;
		}
		await new Promise((r) => setTimeout(r, 200));
	}
	throw new Error('CDP did not come up on port ' + port + (last ? ': ' + last.message : ''));
}

function pickPage(list) {
	const pages = list.filter((t) => t.type === 'page' && t.webSocketDebuggerUrl);
	const harness = pages.find((t) => /harness/.test(t.url || ''));
	return harness || pages[0] || list.find((t) => t.webSocketDebuggerUrl);
}

async function connect(port) {
	const list = await waitForCdp(port, 20000);
	const target = pickPage(list);
	if (!target) throw new Error('no CDP page target on port ' + port);
	const ws = new WebSocket(target.webSocketDebuggerUrl);
	await new Promise((resolve, reject) => {
		ws.once('open', resolve);
		ws.once('error', reject);
	});
	const cdp = new Cdp(ws);
	await cdp.send('Runtime.enable');
	await cdp.send('Page.enable');
	return cdp;
}

async function withCdp(port, fn) {
	const cdp = await connect(port);
	try {
		return await fn(cdp);
	} finally {
		cdp.close();
	}
}

module.exports = { Cdp, connect, withCdp, waitForCdp, httpGetJson };
