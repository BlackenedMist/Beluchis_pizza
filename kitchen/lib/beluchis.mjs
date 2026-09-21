import { seed } from './store.mjs';

function normaliseBase(raw) {
  let base = String(raw || '').trim();
  if (!base) base = process.env.SOURCE_BASE_URL || 'http://localhost:3100';
  return base.replace(/\/+$/, '');
}

function creds() {
  return {
    username: process.env.SOURCE_USERNAME || 'admin',
    pin: process.env.SOURCE_PIN || '1234'
  };
}

function cookieOf(res) {
  const raw = res.headers.get('set-cookie');
  if (!raw) return null;
  const first = raw.split(',').find((p) => p.includes('beluchis_admin')) || raw;
  const pair = first.trim().split(';')[0];
  return pair.startsWith('beluchis_admin=') ? pair : null;
}

export class Upstream {
  constructor(baseUrl) {
    this.baseUrl = normaliseBase(baseUrl);
    this.cookie = null;
    this.username = creds().username;
    this.pin = creds().pin;
  }

  async fail(msg) {
    throw new Error(msg);
  }

  async request(path, opts = {}, allowRetry = true) {
    const headers = { ...(opts.headers || {}) };
    if (this.cookie) headers.cookie = this.cookie;
    if (opts.body) headers['content-type'] = 'application/json';

    let res;
    try {
      res = await fetch(`${this.baseUrl}${path}`, { ...opts, headers });
    } catch (err) {
      return this.fail(`Cannot reach ${this.baseUrl} (${err.cause?.code || err.message})`);
    }

    if (res.status === 401 && allowRetry) {
      await this.login();
      return this.request(path, opts, false);
    }

    const text = await res.text();
    let data = null;
    if (text) {
      try { data = JSON.parse(text); } catch { data = text; }
    }

    if (!res.ok) {
      const detail = typeof data === 'object' && data ? data.error || data.message : text;
      return this.fail(`${res.status} ${detail || res.statusText}`.trim());
    }
    return data;
  }

  async login() {
    const res = await fetch(`${this.baseUrl}/api/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: this.username, pin: this.pin })
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      return this.fail(`Login failed (${res.status} ${text || res.statusText})`);
    }
    this.cookie = cookieOf(res);
    if (!this.cookie) return this.fail('Login succeeded but no session cookie returned');
    return true;
  }

  async fetchOrders() {
    if (!this.cookie) await this.login();
    return this.request('/api/orders', { method: 'GET' });
  }
}