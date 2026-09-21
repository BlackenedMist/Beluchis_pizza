import { Upstream } from './beluchis.mjs';
import { send } from './printer.mjs';
import { buildReceipt, segsToText } from './receipt.mjs';
import { flush, seed } from './store.mjs';

const State = seed('state', { seen: [], log: [], bootstrapped: false, lastPoll: null, lastError: null });
const MAX_KEEP = 200;

export class Poller {
  constructor({ printer = null, autoPrint = true, autoMarkPreparing = true, pollSeconds = 60 }) {
    this.printer = printer;
    this.autoPrint = autoPrint;
    this.autoMarkPreparing = autoMarkPreparing;
    this.pollSeconds = Math.max(10, Number(pollSeconds) || 60);
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
      printer: this.printer ? { name: this.printer.name, type: this.printer.type, host: this.printer.host, port: this.printer.port } : null,
      lastPoll: State.lastPoll,
      lastError: State.lastError,
      nextPollAt: this.lastPollAt + this.pollSeconds * 1000,
    };
  }

  seenSet() {
    return new Set(State.seen);
  }

  async poll() {
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
    const result = { orderId: String(order.id), auto, printer: null, ok: false, ms: 0, error: null, file: null };
    if (!this.autoPrint) {
      result.error = 'auto print disabled (AUTO_PRINT=false)';
      return result;
    }
    if (!this.printer) {
      result.error = 'no printer configured (set PRINTER_HOST)';
      this.logPrint(result);
      console.error(`[kitchen] cannot print order #${order.id}: ${result.error}`);
      return result;
    }

    const segments = buildReceipt(order);
    const text = segsToText(segments);
    result.printer = { id: this.printer.id, name: this.printer.name };
    const sent = await send(this.printer, segments, text);
    Object.assign(result, { ok: sent.ok, ms: sent.ms, error: sent.error || null, file: sent.file || null });
    this.logPrint(result);
    if (result.ok) {
      console.log(`[kitchen] printed order #${order.id} on ${this.printer.name} (${result.ms}ms)`);
      if (this.autoMarkPreparing && order.status === 'placed') {
        await this.markPreparing(order.id);
      }
    } else {
      console.error(`[kitchen] print failed for order #${order.id}: ${result.error} — order stays placed for the cashier`);
    }
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