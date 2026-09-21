import { Upstream } from './beluchis.mjs';
import { send } from './printer.mjs';
import { buildReceipt, segsToText } from './receipt.mjs';
import { flush, seed } from './store.mjs';

const State = seed('state', { seen: [], log: [], bootstrapped: false, lastPoll: null, lastError: null });
const Shop = seed('shop', { open: null, openTime: null, closeTime: null, onlineEnabled: null, forceOpen: null, at: null, error: null });

const clampClosed = (n) => Math.min(86400, Math.max(300, Number(n) || 1800));

export class Poller {
  constructor() {
    this.settings = seed('settings', { sourceBaseUrl: '', pollSeconds: 60, pollClosedSeconds: 1800, updatedAt: null });
    this.printers = seed('printers', { printers: [] });
    this.orders = [];
    this.inFlight = false;
    this.timer = null;
    this.listeners = new Set();
    this.lastPollAt = 0;
    if (!this.settings.sourceBaseUrl) {
      this.settings.sourceBaseUrl = process.env.SOURCE_BASE_URL || 'http://localhost:3100';
      this.settings.pollSeconds = Number(process.env.POLL_SECONDS) || 60;
      flush('settings');
    }
    if (this.settings.pollSeconds < 10 || !Number.isFinite(this.settings.pollSeconds)) {
      this.settings.pollSeconds = 60;
    }
    // Closed-cadence fallback when the shop is not open. Keeps a bounded,
    // server-paced check overnight instead of hammering the site every minute.
    if (this.settings.pollClosedSeconds === undefined || this.settings.pollClosedSeconds === null || !Number.isFinite(this.settings.pollClosedSeconds)) {
      this.settings.pollClosedSeconds = clampClosed(process.env.POLL_CLOSED_SECONDS);
      flush('settings');
    }
  }

  onEvent(fn) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  lastPollData() {
    return State.lastPoll;
  }

  lastErrorData() {
    return State.lastError;
  }

  // How long to wait between polls right now. "Unknown" shop state counts as
  // open so a fresh box polls normally until the first meta round-trip.
  effectiveSeconds() {
    return Shop.open === false ? this.settings.pollClosedSeconds : this.settings.pollSeconds;
  }

  shopData() {
    return {
      open: Shop.open,
      openTime: Shop.openTime,
      closeTime: Shop.closeTime,
      onlineEnabled: Shop.onlineEnabled,
      forceOpen: Shop.forceOpen,
      at: Shop.at,
      error: Shop.error,
      pollSeconds: this.settings.pollSeconds,
      pollClosedSeconds: this.settings.pollClosedSeconds,
      effectiveSeconds: this.effectiveSeconds(),
    };
  }

  nextPollAt() {
    return this.lastPollAt + this.effectiveSeconds() * 1000;
  }

  emit(event) {
    for (const fn of this.listeners) {
      try { fn(event); } catch { /* ignore */ }
    }
  }

  target() {
    return this.printers.printers.find((p) => p.target) || null;
  }

  seenSet() {
    return new Set(State.seen);
  }

  // Fetch public shop status and re-derive the poll cadence from it.
  // Returns true when the shop just went from closed to open (caller should
  // run an immediate catch-up poll, then schedule the fast cadence).
  // On a meta fetch error the previous cadence is kept — the shop is not
  // assumed open *or* closed from stale/unreachable data.
  async refreshShop() {
    if (!this.settings.sourceBaseUrl) return false;
    const prevOpen = Shop.open;
    try {
      const upstream = new Upstream(this.settings.sourceBaseUrl);
      const cfg = await upstream.fetchShopStatus();
      Object.assign(Shop, {
        open: Boolean(cfg && cfg.open),
        openTime: (cfg && cfg.openTime) || null,
        closeTime: (cfg && cfg.closeTime) || null,
        onlineEnabled: cfg ? cfg.onlineEnabled !== false : null,
        forceOpen: Boolean(cfg && cfg.forceOpen),
        at: new Date().toISOString(),
        error: null,
      });
      flush('shop');
      this.emit({ type: 'shop', shop: this.shopData() });
      return prevOpen === false && Shop.open === true;
    } catch (err) {
      Shop.error = String(err.message || err);
      Shop.at = new Date().toISOString();
      flush('shop');
      this.emit({ type: 'shop', shop: this.shopData(), error: true });
      return false;
    }
  }

  // One full cycle: poll for orders, then re-read shop status and reschedule.
  // Option A (server-paced backoff): while the shop is closed the interval
  // stretches to pollClosedSeconds instead of wasting polls overnight.
  async cycle() {
    if (this.inFlight) return { skipped: true };
    const result = await this.poll();
    const reopened = await this.refreshShop();
    if (reopened) {
      // The shop just opened — fetch orders immediately (plus normal fast
      // cadence from here on) so the first morning order is not delayed.
      await this.poll();
    }
    this.schedule();
    return result;
  }

  async poll() {
    if (this.inFlight) return { skipped: true };
    if (!this.settings.sourceBaseUrl) return { skipped: true, error: 'no source url' };
    this.inFlight = true;
    const t0 = Date.now();
    try {
      const upstream = new Upstream(this.settings.sourceBaseUrl);
      const orders = await upstream.fetchOrders();
      this.orders = Array.isArray(orders) ? orders : [];
      const ids = this.seenSet();
      const maxKeep = 200;
      const unchanged = !State.bootstrapped;

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
        State.seen = Array.from(ids).slice(-maxKeep);
        State.lastPoll = { at: new Date().toISOString(), ok: true, count: this.orders.length };
        flush('state');
        this.lastPollAt = Date.now();
        this.emit({ type: 'boot' });
        return { ok: true, count: this.orders.length, bootstrapped: true, newOrders: [] };
      }

      for (const order of newOrders) {
        await this.printOrder(order, null, true);
      }

      State.seen = Array.from(ids).slice(-maxKeep);
      State.lastPoll = { at: new Date().toISOString(), ok: true, count: this.orders.length, new: newOrders.length };
      State.lastError = null;
      flush('state');
      this.lastPollAt = Date.now();
      if (newOrders.length) {
        this.emit({ type: 'new', orderIds: newOrders.map((o) => String(o.id)), at: newOrders[0].createdAt });
      } else {
        this.emit({ type: 'tick' });
      }
      return { ok: true, count: this.orders.length, newOrders: newOrders.map((o) => o.id), ms: Date.now() - t0 };
    } catch (err) {
      State.lastPoll = { at: new Date().toISOString(), ok: false, count: this.orders.length };
      State.lastError = String(err.message || err);
      flush('state');
      this.lastPollAt = Date.now();
      this.emit({ type: 'error', message: String(err.message || err) });
      return { ok: false, error: String(err.message || err) };
    } finally {
      this.inFlight = false;
    }
  }

  async printOrder(order, printerId = null, auto = false) {
    const printer = printerId
      ? this.printers.printers.find((p) => String(p.id) === String(printerId))
      : this.target();
    const result = { orderId: String(order.id), auto, printer: null, ok: false, ms: 0, error: null, file: null };

    if (!printer) {
      result.error = 'No target printer selected';
      this.logPrint(result);
      return result;
    }

    const segments = buildReceipt(order);
    const text = segsToText(segments);
    result.printer = { id: printer.id, name: printer.name };
    const sent = await send(printer, segments, text);
    Object.assign(result, { ok: sent.ok, ms: sent.ms, error: sent.error || null, file: sent.file || null });
    this.logPrint(result);
    if (result.ok) {
      this.emit({ type: 'printed', orderId: String(order.id), printer: printer.name, auto });
    } else {
      this.emit({ type: 'printError', orderId: String(order.id), message: result.error, auto });
    }
    return result;
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
      file: result.file
    });
    State.log = State.log.slice(0, 120);
    flush('state');
  }

  setInterval(seconds) {
    const secs = Math.max(10, Number(seconds) || 60);
    this.settings.pollSeconds = secs;
    this.settings.updatedAt = new Date().toISOString();
    flush('settings');
    this.schedule();
  }

  setClosedInterval(seconds) {
    const secs = clampClosed(seconds);
    this.settings.pollClosedSeconds = secs;
    this.settings.updatedAt = new Date().toISOString();
    flush('settings');
    this.schedule();
  }

  schedule(seconds = this.effectiveSeconds()) {
    if (this.timer) clearInterval(this.timer);
    this.timer = setInterval(() => this.cycle(), seconds * 1000);
    if (this.timer.unref) this.timer.unref();
  }

  start() {
    this.schedule();
    void this.cycle();
  }
}