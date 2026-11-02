import { Upstream } from './beluchis.mjs';
import { send } from './printer.mjs';
import { buildReceipt, segsToText } from './receipt.mjs';
import { flush, seed } from './store.mjs';

const State = seed('state', { seen: [], log: [], bootstrapped: false, lastPoll: null, lastError: null });
const MAX_KEEP = 200;

export class Poller {
  constructor({ autoPrint = true, autoMarkPreparing = true, pollSeconds = 60, sourceBaseUrl = '', kitchenKey = '' }) {
    this.printers = [];
    this.autoPrint = autoPrint;
    this.autoMarkPreparing = autoMarkPreparing;
    this.pollSeconds = Math.max(10, Number(pollSeconds) || 60);
    this.sourceBaseUrl = sourceBaseUrl;
    this.kitchenKey = kitchenKey;
    this.orders = [];
    this.inFlight = false;
    this.timer = null;
    this.lastPollAt = 0;
  }

  status() {
    return {
      bootstrapped: State.bootstrapped,
      orderCount: this.orders.length,
      pollSeconds: this.pollSeconds,
      autoPrint: this.autoPrint,
      autoMarkPreparing: this.autoMarkPreparing,
      printers: this.printers.map((p) => ({ id: p.id, name: p.name, type: p.type, host: p.host, port: p.port, copies: p.copies, enabled: p.enabled })),
      lastPoll: State.lastPoll,
      lastError: State.lastError,
      nextPollAt: this.lastPollAt + this.pollSeconds * 1000,
    };
  }

  seenSet() {
    return new Set(State.seen);
  }

  async fetchPrinters() {
    if (!this.sourceBaseUrl) return;
    try {
      const headers = this.kitchenKey ? { 'x-print-key': this.kitchenKey } : {};
      const res = await fetch(`${this.sourceBaseUrl.replace(/\/$/, '')}/api/kitchen/printers`, { headers });
      if (!res.ok) return;
      const data = await res.json();
      if (Array.isArray(data.printers)) {
        this.printers = data.printers.filter((p) => p.enabled !== false).map((p) => ({
          id: p.id, name: p.name, type: p.type || 'network', host: p.host, port: p.port || 9100, copies: Math.max(1, Number(p.copies) || 1), enabled: p.enabled !== false,
        }));
      }
    } catch (e) { /* ignore */ }
  }

  async sendHeartbeat() {
    if (!this.sourceBaseUrl) return;
    try {
      const headers = { 'content-type': 'application/json' };
      if (this.kitchenKey) headers['x-print-key'] = this.kitchenKey;
      await fetch(`${this.sourceBaseUrl.replace(/\/$/, '')}/api/kitchen/heartbeat`, {
        method: 'POST', headers, body: JSON.stringify({ printers: this.printers.map((p) => ({ id: p.id, online: true, lastPrintAt: new Date().toISOString() })), queue: { count: this.orders.length } }),
      });
    } catch { /* ignore */ }
  }

  async poll() {
    await this.fetchPrinters();
    if (this.inFlight) return { skipped: true };
    if (!process.env.SOURCE_BASE_URL) return { skipped: true, error: 'SOURCE_BASE_URL is not set' };
    this.inFlight = true;
    const t0 = Date.now();
    try {
      const upstream = new Upstream(process.env.SOURCE_BASE_URL);
      const orders = await upstream.fetchOrders();
      this.orders = Array.isArray(orders) ? orders : [];
      const ids = this.seenSet();

      let newOrders = [];
      for (const order of this.orders) {
        if (!ids.has(order.id)) {
          ids.add(order.id);
          if (State.bootstrapped && order.status === 'placed' && order.paymentStatus !== 'failed') {
            newOrders.push(order);
          }
        }
      }

      if (!State.bootstrapped) {
        State.bootstrapped = true;
        State.seen = Array.from(ids).slice(-MAX_KEEP);
        State.lastPoll = { at: new Date().toISOString(), ok: true, count: this.orders.length };
        flush('state');
        this.lastPollAt = Date.now();
        console.log(`[kitchen] bootstrapped with ${this.orders.length} existing order(s); history will not be reprinted`);
        return { ok: true, count: this.orders.length, bootstrapped: true, newOrders: [] };
      }

      const printed = [];
      for (const order of newOrders) {
        printed.push(await this.printOrder(order, true));
      }

      State.seen = Array.from(ids).slice(-MAX_KEEP);
      State.lastPoll = { at: new Date().toISOString(), ok: true, count: this.orders.length, new: newOrders.length };
      State.lastError = null;
      flush('state');
      this.lastPollAt = Date.now();
      return { ok: true, count: this.orders.length, newOrders: newOrders.map((o) => o.id), printed, ms: Date.now() - t0 };
    } catch (err) {
      State.lastPoll = { at: new Date().toISOString(), ok: false, count: this.orders.length };
      State.lastError = String(err.message || err);
      flush('state');
      this.lastPollAt = Date.now();
      console.error(`[kitchen] poll error: ${err.message || err}`);
      return { ok: false, error: String(err.message || err) };
    } finally {
      this.inFlight = false;
    }
  }

  async printOrder(order, auto = false) {
    const result = { orderId: String(order.id), auto, printers: [], ok: false, ms: 0, error: null, file: null };
    if (!this.autoPrint) {
      result.error = 'auto print disabled (AUTO_PRINT=false)';
      return result;
    }
    if (!this.printers.length) {
      result.error = 'no printer configured (add printers in admin)';
      this.logPrint(result);
      console.error(`[kitchen] cannot print order #${order.id}: ${result.error}`);
      return result;
    }

    const segments = buildReceipt(order);
    const text = segsToText(segments);
    let anyOk = false;
    for (const printer of this.printers) {
      for (let c = 0; c < (printer.copies || 1); c++) {
        let sent = await send(printer, segments, text);
        if (!sent.ok) {
          // Auto-resolve: scan the subnet for a printer on the same port.
          try {
            const { scanSubnet } = await import('./printer.mjs');
            const found = await scanSubnet(printer.port || 9100, 400);
            const alt = found.find((h) => h !== printer.host);
            if (alt) {
              console.log(`[kitchen] printer ${printer.name} offline at ${printer.host}; resolved to ${alt}`);
              printer.host = alt;
              // Persist to server.
              try {
                const headers = { 'content-type': 'application/json' };
                if (this.kitchenKey) headers['x-print-key'] = this.kitchenKey;
                const cfg = await fetch(`${this.sourceBaseUrl.replace(/\/$/, '')}/api/kitchen/printers`, { headers });
                if (cfg.ok) {
                  const data = await cfg.json();
                  const updated = (data.printers || []).map((p) => (p.id === printer.id ? { ...p, host: alt } : p));
                  await fetch(`${this.sourceBaseUrl.replace(/\/$/, '')}/api/kitchen/printers`, { method: 'PUT', headers, body: JSON.stringify({ printers: updated }) });
                }
              } catch { /* ignore */ }
              sent = await send(printer, segments, text);
            }
          } catch { /* ignore */ }
        }
        const r = { id: printer.id, name: printer.name, ok: sent.ok, ms: sent.ms, error: sent.error || null, file: sent.file || null };
        result.printers.push(r);
        if (sent.ok) anyOk = true;
        else console.error(`[kitchen] print failed for order #${order.id} on ${printer.name}: ${sent.error}`);
      }
    }
    result.ok = anyOk;
    this.logPrint(result);
    if (result.ok) {
      console.log(`[kitchen] printed order #${order.id}`);
      if (this.autoMarkPreparing && order.status === 'placed') {
        await this.markPreparing(order.id);
      }
    } else {
      console.error(`[kitchen] all prints failed for order #${order.id} — order stays placed for the cashier`);
    }
    await this.sendHeartbeat();
    return result;
  }

  async markPreparing(orderId) {
    try {
      const upstream = new Upstream(process.env.SOURCE_BASE_URL);
      await upstream.request(`/api/orders/${orderId}`, {
        method: 'PUT',
        body: JSON.stringify({ status: 'preparing' }),
      });
      console.log(`[kitchen] order #${orderId} marked preparing`);
      return true;
    } catch (err) {
      console.error(`[kitchen] could not mark order #${orderId} preparing: ${err.message}`);
      return false;
    }
  }

  async reprint(orderId) {
    const order = this.orders.find((o) => String(o.id) === String(orderId));
    if (!order) return { ok: false, error: `order #${orderId} is not in the daemon's latest snapshot` };
    return this.printOrder(order, false);
  }

  logPrint(result) {
    State.log.unshift({
      at: new Date().toISOString(),
      orderId: result.orderId,
      auto: result.auto,
      printer: result.printer ? result.printer.name : null,
      ok: result.ok,
      ms: result.ms,
      error: result.error,
      file: result.file,
    });
    State.log = State.log.slice(0, 120);
    flush('state');
  }

  schedule(seconds = this.pollSeconds) {
    if (this.timer) clearInterval(this.timer);
    this.timer = setInterval(() => this.poll(), seconds * 1000);
    if (this.timer.unref) this.timer.unref();
  }

  start() {
    this.poll();
    this.schedule();
  }
}