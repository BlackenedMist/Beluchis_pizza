import http from 'node:http';
import { Poller } from './lib/poller.mjs';

const PORT = Number(process.env.PORT) || 3101;
const HOST = process.env.HOST || '0.0.0.0';

const printer = {
  id: 'lan-printer',
  name: process.env.PRINTER_NAME || 'Kitchen printer',
  type: process.env.PRINTER_TYPE || 'network', // 'network' | 'file'
  host: process.env.PRINTER_HOST || 'local',
  port: Number(process.env.PRINTER_PORT) || 9100,
};

const poller = new Poller({
  printer,
  autoPrint: String(process.env.AUTO_PRINT ?? 'true').toLowerCase() !== 'false',
  autoMarkPreparing: String(process.env.AUTO_MARK_PREPARING ?? 'true').toLowerCase() !== 'false',
  pollSeconds: Number(process.env.POLL_SECONDS) || 15,
});

const json = (res, code, body) => {
  res.writeHead(code, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
};

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);

  if (req.method === 'GET' && url.pathname === '/health') {
    return json(res, 200, { ok: true, name: 'beluchis-kitchen', uptime: process.uptime(), ...poller.status() });
  }

  if (req.method === 'POST' && url.pathname.startsWith('/api/print/')) {
    const key = process.env.PRINT_KEY;
    if (!key) return json(res, 404, { error: 'reprint endpoint disabled (PRINT_KEY not set)' });
    if (req.headers['x-print-key'] !== key) return json(res, 403, { error: 'invalid x-print-key' });
    const id = Number(url.pathname.split('/').pop());
    if (!Number.isInteger(id)) return json(res, 400, { error: 'invalid order id' });
    const result = await poller.reprint(id);
    return json(res, result.ok ? 200 : 409, result);
  }

  return json(res, 404, { error: 'not found' });
});

server.listen(PORT, HOST, () => {
  const mode = printer.type === 'file' ? `file printer → ${process.env.STORAGE_DIR || 'data'}/prints` : `network printer ${printer.host}:${printer.port}`;
  console.log(`[kitchen] Beluchis kitchen printer daemon listening on http://${HOST}:${PORT}`);
  console.log(`[kitchen] target: ${mode}`);
  console.log(`[kitchen] polls ${process.env.SOURCE_BASE_URL || 'http://localhost:3100'} every ${poller.pollSeconds}s`);
  if (!poller.autoPrint) console.log('[kitchen] WARNING: AUTO_PRINT=false — new orders will not print');
});

const shutdown = () => {
  console.log('[kitchen] shutting down');
  if (poller.timer?.unref) clearInterval(poller.timer);
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 2000).unref();
};
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);

poller.start();