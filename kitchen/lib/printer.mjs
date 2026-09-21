import { appendFileSync, writeFileSync } from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { PRINTS_DIR } from './store.mjs';
import { buildEscpos, testPage } from './escpos.mjs';

function sendTcp(printer, buffer, timeoutMs = 6000) {
  return new Promise((resolve) => {
    const t0 = Date.now();
    const socket = net.connect({ host: printer.host, port: printer.port });
    let done = false;
    let timer;

    const finish = (ok, error) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      socket.removeAllListeners();
      socket.destroy();
      resolve({ ok, ms: Date.now() - t0, error });
    };

    timer = setTimeout(() => { socket.destroy(); finish(false, 'timeout'); }, timeoutMs);

    socket.on('connect', () => {
      socket.write(buffer);
      socket.end();
    });
    socket.on('error', (err) => finish(false, err.code || err.message));
    socket.on('close', (hadError) => {
      if (!hadError) finish(true);
    });
  });
}

function writeFile(printer, text) {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const name = String(printer.name || printer.id).replace(/[^a-z0-9]+/gi, '_').slice(0, 40);
  const file = path.join(PRINTS_DIR, `${stamp}-${name}.txt`);
  writeFileSync(file, text);
  return { file };
}

export async function send(printer, segments, text) {
  if (printer.type === 'file') {
    return { ok: true, ms: 0, ...writeFile(printer, text) };
  }
  const buffer = buildEscpos(segments);
  return sendTcp(printer, buffer);
}

export async function testPrinter(printer) {
  const text = ['.BELUCHIS KITCHEN.', 'Printer test OK', String(new Date().toLocaleString()), 'If you can read this line,', 'everything is working.'].join('\n');
  if (printer.type === 'file') {
    return { ok: true, ms: 0, ...writeFile(printer, text) };
  }
  return sendTcp(printer, testPage());
}

export function appendLog(file, line) {
  try {
    appendFileSync(path.join(PRINTS_DIR, file), `${line}\n`);
  } catch { /* ignore */ }
}