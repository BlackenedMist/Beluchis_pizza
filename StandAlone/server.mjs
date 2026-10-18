import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
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

// ---------------------------------------------------------------- auth
// Opt-in: set BRIDGE_PASSWORD in .env to require a password on the page.
// Without it the bridge stays open (backwards compatible) but warns loudly
// at startup, because it binds to 0.0.0.0 and exposes customer order data.
const BRIDGE_PASSWORD = String(process.env.BRIDGE_PASSWORD || '');
const AUTH_ENABLED = BRIDGE_PASSWORD.length > 0;
const AUTH_COOKIE = 'bridge_auth';

// Random per process, so restarting the bridge invalidates existing sessions.
const SESSION_TOKEN = randomBytes(32).toString('hex');

// Brute-force guard: exponential backoff after repeated failures.
let loginFails = 0;
let loginBlockedUntil = 0;

function safeEqual(a, b) {
  const ab = Buffer.from(String(a), 'utf8');
  const bb = Buffer.from(String(b), 'utf8');
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

function parseCookies(req) {
  const out = {};
  for (const part of String(req.headers.cookie || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = part.slice(i + 1).trim();
  }
  return out;
}

function isAuthed(req) {
  if (!AUTH_ENABLED) return true;
  return safeEqual(parseCookies(req)[AUTH_COOKIE] || '', SESSION_TOKEN);
}

function cookieHeader(value, maxAge) {
  return `${AUTH_COOKIE}=${value}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${maxAge}`;
}

function sendLoginPage(res, message) {
  const body = loginHtml(message);
  res.writeHead(200, {
    'content-type': 'text/html; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(body)
  });
  res.end(body);
}

function loginHtml(message) {
  const notice = message ? `<p class="err">${message}</p>` : '';
  return `<!doctype html><html><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Beluchis Kitchen Bridge</title><style>
:root{color-scheme:dark light}
body{font:16px/1.5 system-ui,sans-serif;margin:0;min-height:100vh;display:grid;place-items:center;background:#14120f;color:#f4efe6}
form{width:min(340px,86vw);background:#1e1a16;padding:28px;border-radius:12px;border:1px solid #3a332b}
h1{font-size:19px;margin:0 0 4px}
p.sub{color:#a29684;font-size:13px;margin:0 0 20px}
input{width:100%;box-sizing:border-box;padding:11px;border-radius:8px;border:1px solid #4a4238;background:#141210;color:#f4efe6;font-size:16px}
button{width:100%;margin-top:12px;padding:11px;border:0;border-radius:8px;background:#c8102e;color:#fff;font-size:16px;font-weight:600;cursor:pointer}
.err{color:#ff8a8a;font-size:13px;margin:0 0 12px}
</style></head><body><form method="POST" action="/login">
<h1>Kitchen Bridge</h1>
<p class="sub">Beluchis &mdash; restaurant network</p>
${notice}
<input type="password" name="password" placeholder="Password" autofocus autocomplete="current-password" required>
<button type="submit">Unlock</button>
</form></body></html>`;
}

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
      // JSON (the API) or urlencoded (the login form)
      if (String(req.headers['content-type'] || '').includes('application/x-www-form-urlencoded')) {
        const out = {};
        for (const [k, v] of new URLSearchParams(raw)) out[k] = v;
        return resolve(out);
      }
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

  // ---- auth gate: everything is locked except the login form itself ----
  if (AUTH_ENABLED && p !== '/login' && !isAuthed(req)) {
    if (p.startsWith('/api/')) return json(res, 401, { error: 'auth required' });
    return sendLoginPage(res);
  }

  // ---- login / logout ----
  if (method === 'POST' && p === '/login') {
    const body = await readBody(req);
    if (Date.now() < loginBlockedUntil) {
      return sendLoginPage(res, 'Too many attempts. Wait a minute and try again.');
    }
    if (safeEqual(body.password || '', BRIDGE_PASSWORD)) {
      loginFails = 0;
      res.writeHead(302, {
        'set-cookie': cookieHeader(SESSION_TOKEN, 60 * 60 * 12),
        location: '/'
      });
      return res.end();
    }
    loginFails += 1;
    if (loginFails >= 5) {
      loginBlockedUntil = Date.now() + 60_000;
      loginFails = 0;
    }
    return sendLoginPage(res, 'Wrong password.');
  }

  if (method === 'POST' && p === '/logout') {
    res.writeHead(302, { 'set-cookie': cookieHeader('', 0), location: '/login' });
    return res.end();
  }

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
  const host = process.env.HOST || '0.0.0.0';
  server.listen(port, host);

  if (AUTH_ENABLED) {
    console.log(`Kitchen bridge is password-locked (BRIDGE_PASSWORD set).`);
  } else {
    console.warn('');
    console.warn('  ============================================================');
    console.warn('   NO PASSWORD SET - this page is open to the whole network.');
    console.warn('   Set BRIDGE_PASSWORD in .env to lock it.');
    console.warn('  ============================================================');
    console.warn('');
  }

  poller.start();
  return server;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  start();
}