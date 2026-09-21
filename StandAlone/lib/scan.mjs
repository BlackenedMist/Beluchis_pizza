import net from 'node:net';
import os from 'node:os';

export function localIPv4() {
  const interfaces = os.networkInterfaces();
  for (const key of Object.keys(interfaces)) {
    for (const addr of interfaces[key] || []) {
      if (addr.family === 'IPv4' && !addr.internal) return addr.address;
    }
  }
  return null;
}

export function subnetRange() {
  const ip = localIPv4();
  if (!ip) return null;
  const parts = ip.split('.');
  if (parts.length !== 4) return null;
  return `${parts.slice(0, 3).join('.')}.`;
}

function probe(host, port, timeoutMs) {
  return new Promise((resolve) => {
    const t0 = Date.now();
    const socket = net.connect({ host, port });
    let done = false;
    let timer;

    const finish = (ok, error) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      socket.removeAllListeners();
      socket.destroy();
      resolve({ host, port, ok, ms: Date.now() - t0, error: ok ? null : (error || 'closed') });
    };

    timer = setTimeout(() => { socket.destroy(); finish(false, 'timeout'); }, timeoutMs);
    socket.on('connect', () => finish(true));
    socket.on('error', (err) => finish(false, err.code || err.message));
  });
}

export async function scanLan({ ports = [9100], concurrency = 50, timeoutMs = 400 } = {}) {
  const base = subnetRange();
  if (!base) return { base: null, found: [] };
  const hosts = Array.from({ length: 254 }, (_, i) => `${base}${i + 1}`);
  const found = [];
  let cursor = 0;

  const worker = async () => {
    while (cursor < hosts.length) {
      const host = hosts[cursor++];
      for (const port of ports) {
        const result = await probe(host, port, timeoutMs);
        if (result.ok) found.push(result);
      }
    }
  };

  await Promise.all(Array.from({ length: Math.min(concurrency, hosts.length) }, worker));
  found.sort((a, b) => a.host.localeCompare(b.host, undefined, { numeric: true }));
  return { base: `${base}1-254`, localIp: localIPv4(), found };
}