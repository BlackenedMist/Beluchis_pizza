import { appendFileSync, writeFileSync } from 'node:fs';
import { execFile } from 'node:child_process';
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

// Escape a value for a PowerShell single-quoted string literal. Doubling the
// quote is the only escape PowerShell recognises inside '...'.
function psQuote(value) {
  return `'${String(value).replace(/'/g, "''")}'`;
}

// Print through a Windows print queue instead of straight to port 9100. This is
// how a USB thermal printer shared over SMB (e.g. \\pos2\Invoice) is reached:
// the share is installed on this machine as a printer.
//
// Two things are deliberately different from the network path:
//   - There are no ESC/POS bytes to send. The driver renders the text, so a slip
//     printed this way is plain text with no cut/init commands. Keep a real
//     9100 printer as the target for kitchen slips.
//   - Out-Printer only exists in Windows PowerShell 5.1, so powershell.exe is
//     called by full name rather than whatever "powershell" resolves to.
//
// Not every shared queue can be printed through GDI+. A share whose driver has
// no usable DEVMODE makes Out-Printer fail with InvalidPrinterException even
// though the printer is online and working. The share itself still accepts a
// raw write, so that is the fallback. Whichever route ran is reported back so
// the print log shows which one the machine actually used.
//
// The slip always goes through a file first, so nothing has to survive a
// command line and the printed text is kept in data/prints as a record.
function runCommand(file, cmd, args, timeoutMs) {
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout: timeoutMs, windowsHide: true, encoding: 'utf8' }, (err, _stdout, stderr) => {
      resolve({ err: err || null, detail: String(stderr || '').trim() });
    });
  });
}

// Pull a readable sentence out of a PowerShell error rather than whatever line
// happens to be last - the tail of a .NET stack trace is always method names.
function summariseError(detail, fallback) {
  const line = detail
    .split(/\r?\n/)
    .map((l) => l.trim())
    .find((l) => l && !/^\+|^At line|CategoryInfo|FullyQualifiedErrorId|^char:/.test(l));
  if (!line) return fallback;
  return line
    .replace(/^\w[\w.+]*Exception\s*:\s*/, '')
    .replace(/^out-lineoutput\s*:\s*/i, '')
    .slice(0, 160);
}

async function sendWindows(printer, text, timeoutMs = 20000) {
  const t0 = Date.now();
  let file;
  try {
    file = writeFile(printer, text).file;
  } catch (err) {
    return { ok: false, ms: Date.now() - t0, error: err.code || err.message };
  }

  const share = printer.host.trim();

  // 1. Through the print driver. This is the route that respects the paper
  //    width and margins the driver was set up with.
  const driver = await runCommand(file, 'powershell.exe', [
    '-NoProfile',
    '-NonInteractive',
    '-Command',
    `Get-Content -LiteralPath ${psQuote(file)} -Raw | Out-Printer -Name ${psQuote(share)}`
  ], timeoutMs);

  if (!driver.err) {
    return { ok: true, ms: Date.now() - t0, error: null, file, via: 'driver' };
  }

  // 2. Raw write straight to the share. Bypasses the driver completely, so the
  //    slip is plain text, but it reaches queues GDI+ refuses to touch.
  const raw = await runCommand(file, 'cmd.exe', ['/d', '/c', 'copy', '/b', file, share], timeoutMs);

  if (!raw.err) {
    return {
      ok: true,
      ms: Date.now() - t0,
      error: null,
      file,
      via: 'raw share',
      note: 'printed straight to the share (the print driver could not be used for this queue)'
    };
  }

  return {
    ok: false,
    ms: Date.now() - t0,
    file,
    error: summariseError(raw.detail, raw.err.message) || summariseError(driver.detail, driver.err.message)
  };
}

export async function send(printer, segments, text) {
  if (printer.type === 'file') {
    return { ok: true, ms: 0, ...writeFile(printer, text) };
  }
  if (printer.type === 'windows') {
    return sendWindows(printer, text.replace(/\r?\n/g, '\r\n'));
  }
  const buffer = buildEscpos(segments);
  return sendTcp(printer, buffer);
}

export async function testPrinter(printer) {
  const text = ['.BELUCHIS KITCHEN.', 'Printer test OK', String(new Date().toLocaleString()), 'If you can read this line,', 'everything is working.'].join('\n');
  if (printer.type === 'file') {
    return { ok: true, ms: 0, ...writeFile(printer, text) };
  }
  if (printer.type === 'windows') {
    return sendWindows(printer, text.replace(/\r?\n/g, '\r\n'));
  }
  return sendTcp(printer, testPage());
}

export function appendLog(file, line) {
  try {
    appendFileSync(path.join(PRINTS_DIR, file), `${line}\n`);
  } catch { /* ignore */ }
}