import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Poller } from './lib/poller.mjs';
import { buildReceipt, segsToText } from './lib/receipt.mjs';
import { localIPv4, scanLan } from './lib/scan.mjs';
import { flush, seed } from './lib/store.mjs';
import { testPrinter } from './lib/printer.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)));
const PUBLIC = path.join(ROOT, 'public');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon'
};

export const poller = new Poller();
poller.printers = seed('printers', { printers: [] });

const sseClients = new Set();
let scanning = false;

function broadcast(event) {
  const payload = `data: ${JSON.stringify(event)}\n\n`;
  for (const res of sseClients) {
    res.write(payload);
  }
}
poller.onEvent(broadcast);

function json(res, code, body) {
  const payload = JSON.stringify(body);
  res.writeHead(code, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store'
  });
  res.end(payload);
}

function readBody(req) {
  return new Promise((resolve) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      if (!raw) return resolve({});
      try { resolve(JSON.parse(raw)); } catch { resolve({}); }
    });
    req.on('error', () => resolve({}));
  });
}

function serveStatic(res, file, req) {
  const absolute = path.join(PUBLIC, file);
  if (!absolute.startsWith(PUBLIC)) return json(res, 403, { error: 'forbidden' });
  let data;
  try {
    data = readFileSync(absolute);
  } catch {
    return json(res, 404, { error: 'not found' });
  }
  const etag = createHash('md5').update(data).digest('hex');
  if (req.headers['if-none-match'] === etag) {
    res.writeHead(304, { etag });
    return res.end();
  }
  res.writeHead(200, {
    'content-type': MIME[path.extname(absolute)] || 'application/octet-stream',
    'cache-control': 'no-cache',
    etag
  });
  res.end(data);
}

function printerView(p) {
  return { ...p, target: !!p.target };
}

function findPrinter(id) {
  return poller.printers.printers.find((p) => String(p.id) === String(id)) || null;
}

async function handle(req, res) {
  const url = new URL(req.url, 'http://localhost');
  const p = url.pathname;
  const method = req.method;

  if (method === 'GET' && (p === '/' || p === '/index.html')) {
    return serveStatic(res, 'index.html', req);
  }
  if (method === 'GET' && (p === '/app.js' || p === '/app.css')) {
    return serveStatic(res, p.slice(1), req);
  }

  if (method === 'GET' && p === '/api/events') {
    res.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache',
      connection: 'keep-alive'
    });
    res.write(': connected\n\n');
    const heartbeat = setInterval(() => {
      try { res.write(': ping\n\n'); } catch { /* ignore */ }
    }, 25000);
    if (heartbeat.unref) heartbeat.unref();
    sseClients.add(res);
    req.on('close', () => {
      clearInterval(heartbeat);
      sseClients.delete(res);
    });
    return;
  }

  if (method === 'GET' && p === '/api/status') {
    const s = poller.settings;
    return json(res, 200, {
      localIp: localIPv4(),
      settings: { sourceBaseUrl: s.sourceBaseUrl, pollSeconds: s.pollSeconds, pollClosedSeconds: s.pollClosedSeconds, updatedAt: s.updatedAt },
      configured: !!s.sourceBaseUrl,
      printers: poller.printers.printers.map(printerView),
      lastPoll: poller.lastPollData(),
      lastError: poller.lastErrorData(),
      shop: poller.shopData(),
      scanning,
      nextPollAt: poller.nextPollAt()
    });
  }

  if (method === 'GET' && p === '/api/orders') {
    return json(res, 200, { orders: poller.orders.slice(0, 60) });
  }

  if (method === 'GET' && p.startsWith('/api/orders/') && p.endsWith('/receipt')) {
    const id = p.split('/')[3];
    const order = poller.orders.find((o) => String(o.id) === id);
    if (!order) return json(res, 404, { error: 'order not found' });
    const segments = buildReceipt(order);
    return json(res, 200, { id, text: segsToText(segments), segments });
  }

  if (method === 'POST' && p.startsWith('/api/print/')) {
    const id = p.split('/')[3];
    const body = await readBody(req);
    const order = poller.orders.find((o) => String(o.id) === id);
    if (!order) return json(res, 404, { error: 'order not found' });
    const result = await poller.printOrder(order, body.printerId || null, !!body.auto);
    return json(res, result.ok ? 200 : 409, result);
  }

  if (method === 'POST' && p === '/api/poll') {
    const result = await poller.poll();
    return json(res, result.ok ? 200 : 502, result);
  }

  if (method === 'POST' && p === '/api/scan') {
    if (scanning) return json(res, 409, { error: 'scan already running' });
    scanning = true;
    try {
      const result = await scanLan({});
      return json(res, 200, result);
    } catch (err) {
      return json(res, 500, { error: String(err.message || err) });
    } finally {
      scanning = false;
    }
  }

  if (method === 'GET' && p === '/api/printers') {
    return json(res, 200, { printers: poller.printers.printers.map(printerView) });
  }

  if (method === 'POST' && p === '/api/printers') {
    const body = await readBody(req);
    const name = String(body.name || '').trim();
    const host = String(body.host || '').trim();
    if (!name || !host) return json(res, 400, { error: 'name and host required' });
    const id = body.id || createHash('md5').update(`${Date.now()}${Math.random()}`).digest('hex').slice(0, 10);
    const existing = findPrinter(id);
    const kind = body.type === 'file' ? 'file' : 'network';
    const printer = existing
      ? { ...existing, name, host, port: Number(body.port) || 9100, type: kind }
      : { id, name, host, port: Number(body.port) || 9100, type: kind, target: false, lastTest: null };
    if (existing) {
      const idx = poller.printers.printers.indexOf(existing);
      poller.printers.printers[idx] = printer;
    } else {
      poller.printers.printers.push(printer);
    }
    flush('printers');
    return json(res, 200, { printer: printerView(printer) });
  }

  if (method === 'PUT' && p.startsWith('/api/printers/')) {
    const id = p.split('/')[3];
    const printer = findPrinter(id);
    if (!printer) return json(res, 404, { error: 'printer not found' });
    const body = await readBody(req);
    if (body.name !== undefined) printer.name = String(body.name).trim() || printer.name;
    if (body.host !== undefined) printer.host = String(body.host).trim() || printer.host;
    if (body.port !== undefined) printer.port = Number(body.port) || 9100;
    flush('printers');
    return json(res, 200, { printer: printerView(printer) });
  }

  if (method === 'DELETE' && p.startsWith('/api/printers/')) {
    const id = p.split('/')[3];
    const before = poller.printers.printers.length;
    poller.printers.printers = poller.printers.printers.filter((pr) => String(pr.id) !== String(id));
    flush('printers');
    return json(res, 200, { removed: poller.printers.printers.length < before });
  }

  if (method === 'POST' && p.startsWith('/api/printers/') && p.endsWith('/test')) {
    const id = p.split('/')[3];
    const printer = findPrinter(id);
    if (!printer) return json(res, 404, { error: 'printer not found' });
    const result = await testPrinter(printer);
    printer.lastTest = { ok: result.ok, ms: result.ms, error: result.error || null, at: new Date().toISOString() };
    flush('printers');
    return json(res, result.ok ? 200 : 502, { test: printer.lastTest });
  }

  if (method === 'POST' && p.startsWith('/api/printers/') && p.endsWith('/target')) {
    const id = p.split('/')[3];
    const printer = findPrinter(id);
    if (!printer) return json(res, 404, { error: 'printer not found' });
    for (const each of poller.printers.printers) each.target = String(each.id) === String(id);
    flush('printers');
    return json(res, 200, { printer: printerView(printer) });
  }

  if (method === 'POST' && p === '/api/settings') {
    const body = await readBody(req);
    if (body.sourceBaseUrl !== undefined) {
      poller.settings.sourceBaseUrl = String(body.sourceBaseUrl).trim().replace(/\/+$/, '');
    }
    if (body.pollSeconds !== undefined) {
      poller.setInterval(Number(body.pollSeconds));
    }
    if (body.pollClosedSeconds !== undefined) {
      poller.setClosedInterval(Number(body.pollClosedSeconds));
    }
    flush('settings');
    return json(res, 200, {
      settings: {
        sourceBaseUrl: poller.settings.sourceBaseUrl,
        pollSeconds: poller.settings.pollSeconds,
        pollClosedSeconds: poller.settings.pollClosedSeconds
      }
    });
  }

  if (method === 'GET' && p === '/api/log') {
    const state = seed('state', { seen: [], log: [], bootstrapped: false, lastPoll: null, lastError: null });
    return json(res, 200, { log: state.log.slice(0, 100), bootstrapped: state.bootstrapped });
  }

  notFound(res);
}

function notFound(res) {
  json(res, 404, { error: 'not found' });
}

export function start() {
  const server = http.createServer((req, res) => {
    handle(req, res).catch((err) => {
      try { json(res, 500, { error: String(err.message || err) }); } catch { /* ignore */ }
    });
  });
  const port = Number(process.env.PORT) || 3101;
  server.listen(port, process.env.HOST || '0.0.0.0');
  poller.start();
  return server;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  start();
}