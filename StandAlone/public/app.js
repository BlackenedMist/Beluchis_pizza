const $ = (sel) => document.querySelector(sel);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

let status = { settings: { pollSeconds: 60, pollClosedSeconds: 1800, sourceBaseUrl: '' }, printers: [], scanning: false, online: true, lastPoll: null, nextPollAt: 0, localIp: null, shop: null };

function money(v) {
  const raw = Number(v || 0);
  const fixed = raw.toFixed(2);
  return `R${fixed.replace(/\.00$/, '')}`;
}

function payLabel(order) {
  if (order.paymentMethod === 'paygate') {
    if (order.paymentStatus === 'paid') return 'Paid online';
    if (order.paymentStatus === 'failed') return 'Payment failed';
    return 'Payment pending';
  }
  if (order.paymentMethod === 'cod_card') return 'Card on delivery';
  if (order.paymentMethod === 'cod_cash') return 'Cash on delivery';
  return '';
}

function fmtTime(input) {
  const d = new Date(input);
  if (Number.isNaN(d.getTime())) return String(input);
  return d.toLocaleString('en-ZA', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' });
}

// ---------- tabs ----------
document.querySelectorAll('.tab').forEach((btn) => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.tab').forEach((b) => b.classList.remove('active'));
    document.querySelectorAll('.panel').forEach((p) => p.classList.remove('active'));
    btn.classList.add('active');
    $('#panel-' + btn.dataset.tab).classList.add('active');
    if (btn.dataset.tab === 'orders') loadOrders();
    if (btn.dataset.tab === 'printers') { loadPrinters(); renderStatus(); }
    if (btn.dataset.tab === 'settings') { renderLog(); renderSettingsForm(); }
  });
});

// ---------- status ----------
function renderStatus() {
  const s = status;
  const dot = $('#statusDot');
  dot.className = 'dot ' + (s.lastPoll ? (s.lastPoll.ok ? 'on' : 'off') : 'on');

  const pulse = $('#pulse');
  const effSec = (s.shop && s.shop.effectiveSeconds) || s.settings.pollSeconds || 60;
  if (s.lastPoll && s.nextPollAt) {
    const now = Date.now();
    const span = s.nextPollAt - now;
    const pct = Math.max(0, Math.min(100, 100 * (1 - span / (effSec * 1000))));
    pulse.innerHTML = `<span class="bar" style="width:${pct}%"></span>`;
    pulse.classList.toggle('late', span < 0);
  } else {
    pulse.innerHTML = '';
  }

  const meta = $('#orderMeta');
  if (meta) {
    const last = s.lastPoll;
    const shopNote = s.shop
      ? s.shop.open === false
        ? ` · Shop closed — checking every ${Math.round(effSec / 60)} min`
        : s.shop.open === true
          ? ' · Open'
          : s.shop.error
            ? ' · Status unknown'
            : ''
      : '';
    meta.textContent = s.lastPoll
      ? `Last check: ${fmtTime(last.at)}${last.ok ? '' : '  (could not reach the website)'}${shopNote}`
      : 'Checking the website…';
  }

  const pMeta = $('#printerMeta');
  if (pMeta) {
    const target = s.printers.find((p) => p.target);
    pMeta.textContent = s.printers.length
      ? `${s.printers.length} printer${s.printers.length === 1 ? '' : 's'} added · Auto-prints to: ${target ? target.name : 'none yet'}`
      : '';
  }

  const hint = $('#scanHint');
  if (hint && s.localIp) hint.textContent = `This box is on ${s.localIp} — the app looks at that network. Click to search it.`;
}

async function loadStatus() {
  try {
    const r = await fetch('/api/status', { cache: 'no-store' });
    status = await r.json();
    renderStatus();
  } catch { /* ignore */ }
}

// ---------- orders ----------
let orders = [];
async function loadOrders() {
  try {
    const r = await fetch('/api/orders', { cache: 'no-store' });
    const data = await r.json();
    orders = data.orders || [];
    renderOrders();
  } catch { /* ignore */ }
}

function orderRow(order) {
  const tpl = $('#orderCard');
  const node = tpl.content.cloneNode(true);
  const card = node.querySelector('.order');
  card.dataset.id = order.id;
  node.querySelector('.order-no').textContent = '#' + order.id;
  const type = order.deliveryAddress ? 'delivery' : 'collection';
  const typeBadge = node.querySelector('.type-badge');
  typeBadge.textContent = order.deliveryAddress ? 'Delivery' : 'Collection';
  typeBadge.classList.add(type);
  node.querySelector('.order-time').textContent = fmtTime(order.createdAt);

  const ul = node.querySelector('.items');
  (order.items || []).forEach((item) => {
    const li = document.createElement('li');
    const name = `${item.quantity}x ${item.itemName || 'Item'}${item.sizeLabel ? ` (${item.sizeLabel})` : ''}`;
    li.innerHTML = `<span><span class="q">${esc(item.quantity)}×</span> ${esc(name)}</span><span>${money(item.total)}</span>`;
    ul.appendChild(li);
    if (item.extras) {
      try {
        for (const extra of JSON.parse(item.extras)) {
          const ex = document.createElement('li');
          ex.className = 'extra';
          ex.textContent = '   + ' + (extra.name || extra);
          ul.appendChild(ex);
        }
      } catch { /* ignore */ }
    }
  });

  if (order.notes) {
    const notes = node.querySelector('.notes');
    notes.textContent = esc(order.notes);
    notes.removeAttribute('hidden');
  }

  const cust = node.querySelector('.customer');
  const name = [order.customer?.firstName, order.customer?.lastName].filter(Boolean).join(' ');
  const addr = order.deliveryAddress ? ` · ${order.deliveryAddress}` : '';
  if (name || order.customer?.cellphone) {
    cust.textContent = `${name || ''}${order.customer?.cellphone ? ` · ${order.customer.cellphone}` : ''}${addr}`;
  }

  const pay = node.querySelector('.payment');
  const label = payLabel(order);
  if (label) {
    pay.textContent = label;
    if (order.paymentStatus === 'paid') pay.classList.add('paid-online');
  }

  node.querySelector('.total').textContent = money(order.grandTotal ?? order.total);

  node.querySelector('.preview').addEventListener('click', async () => {
    const box = node.querySelector('.receipt');
    if (!box.hidden) { box.hidden = true; return; }
    try {
      const r = await fetch(`/api/orders/${order.id}/receipt`, { cache: 'no-store' });
      const data = await r.json();
      box.textContent = data.text || '';
      box.hidden = false;
    } catch { /* ignore */ }
  });

  node.querySelector('.reprint').addEventListener('click', async () => {
    const btn = node.querySelector('.reprint');
    btn.disabled = true;
    try {
      const r = await fetch(`/api/print/${order.id}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
      const data = await r.json();
      toast(r.ok ? `Printed to ${data.printer ? data.printer.name : 'printer'}` : `Print failed: ${data.error}`, r.ok);
    } catch { toast('Print request failed', false); }
    btn.disabled = false;
  });

  return node;
}

function renderOrders() {
  const wrap = $('#orders');
  wrap.innerHTML = '';
  const list = orders.slice(0, 60);
  if (!list.length) {
    wrap.innerHTML = '<div class="card muted">No orders yet. They will appear here as soon as someone orders online.</div>';
    return;
  }
  for (const order of list) wrap.appendChild(orderRow(order));
}

// ---------- printers ----------
async function loadPrinters() {
  try {
    const r = await fetch('/api/printers', { cache: 'no-store' });
    const data = await r.json();
    status.printers = data.printers || [];
    status.lastPoll = status.lastPoll || null;
    renderPrinters();
    renderStatus();
  } catch { /* ignore */ }
}

function printerRow(pr) {
  const div = document.createElement('div');
  div.className = 'printer-row' + (pr.target ? ' target' : '');
  const t = pr.lastTest || null;
  const testHtml = t
    ? (t.ok
        ? `<span class="printer-test test-ok">✓ Test ok · ${t.ms}ms</span>`
        : `<span class="printer-test test-fail">✗ Test failed · ${esc(t.error || 'error')}</span>`)
    : '<span class="printer-test muted">Not tested yet</span>';
  const targetHtml = pr.target ? '<span class="target-label">★ Target</span>' : '';
  div.innerHTML = `
    <div>
      <div class="printer-name">${esc(pr.name)}</div>
      <div class="printer-host">${esc(pr.host)}:${pr.port|0}</div>
      ${testHtml}
    </div>
    <div class="printer-actions">
      ${targetHtml}
      <button class="btn small set-target" ${pr.target ? 'disabled' : ''}>Set as target</button>
      <button class="btn small test">Test</button>
      <button class="btn small rename">Rename</button>
      <button class="btn small del">Remove</button>
    </div>`;

  div.querySelector('.test').addEventListener('click', async () => {
    const btn = div.querySelector('.test');
    btn.disabled = true;
    btn.textContent = '…';
    try {
      const r = await fetch(`/api/printers/${pr.id}/test`, { method: 'POST' });
      const data = await r.json();
      window.location.hash = 'printers';
      toast(r.ok ? `Test page sent to ${pr.name}` : `Test failed: ${data.test?.error || data.error}`, r.ok);
    } catch { toast('Could not test printer', false); }
    await loadPrinters();
  });

  div.querySelector('.set-target').addEventListener('click', async () => {
    await fetch(`/api/printers/${pr.id}/target`, { method: 'POST' });
    toast(`${pr.name} is now the target for new orders`, true);
    await loadPrinters();
  });

  div.querySelector('.rename').addEventListener('click', async () => {
    const name = prompt(`Name for ${pr.host}:`, pr.name);
    if (name === null || !name.trim()) return;
    await fetch(`/api/printers/${pr.id}`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: name.trim() })
    });
    await loadPrinters();
  });

  div.querySelector('.del').addEventListener('click', async () => {
    if (!confirm(`Remove ${pr.name}?`)) return;
    await fetch(`/api/printers/${pr.id}`, { method: 'DELETE' });
    await loadPrinters();
  });

  return div;
}

function renderPrinters() {
  const wrap = $('#printerList');
  wrap.innerHTML = '';
  if (!status.printers.length) {
    wrap.innerHTML = '<div class="card muted">No printers added yet. Scan the network or add one below.</div>';
    return;
  }
  for (const pr of status.printers) wrap.appendChild(printerRow(pr));
}

async function runScan() {
  const btn = $('#scanBtn');
  const state = $('#scanState');
  const results = $('#scanResults');
  btn.disabled = true;
  state.textContent = 'Scanning… give it a few seconds.';
  results.innerHTML = '';
  try {
    const r = await fetch('/api/scan', { method: 'POST' });
    const data = await r.json();
    if (!r.ok) {
      state.textContent = `Scan problem: ${data.error}`;
      return;
    }
    state.textContent = `Checked ${data.base || 'the network'} — found ${data.found.length}.`;
    results.innerHTML = '';
    if (!data.found.length) {
      results.innerHTML = '<div class="card muted">No printers found. Check the printer is switched on and connected to the same router, then try again — or add it manually below.</div>';
      return;
    }
    for (const hit of data.found) {
      const row = document.createElement('div');
      row.className = 'found-host';
      row.innerHTML = `
        <div>
          <div class="ip">${esc(hit.host)}</div>
          <div class="ok-ms">Port ${hit.port} open · responded in ${hit.ms}ms</div>
        </div>
        <button class="btn small add-found">Add</button>`;
      row.querySelector('.add-found').addEventListener('click', async () => {
        await fetch('/api/printers', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ name: `Printer ${hit.host}`, host: hit.host, port: hit.port })
        });
        row.remove();
        toast(`Added ${hit.host} — test it, then set it as target.`, true);
        await loadPrinters();
      });
      results.appendChild(row);
    }
  } catch (err) {
    state.textContent = 'Scan failed.';
  } finally {
    btn.disabled = false;
  }
}

// ---------- settings ----------
async function renderSettingsForm() {
  $('#sUrl').value = status.settings.sourceBaseUrl || '';
  $('#sSec').value = status.settings.pollSeconds || 60;
  $('#sClosed').value = status.settings.pollClosedSeconds || 1800;
}

async function renderLog() {
  try {
    const r = await fetch('/api/log', { cache: 'no-store' });
    const data = await r.json();
    const wrap = $('#logList');
    wrap.innerHTML = '';
    if (!data.log || !data.log.length) {
      wrap.innerHTML = '<div class="muted">No print activity yet.</div>';
      return;
    }
    for (const entry of data.log) {
      const row = document.createElement('div');
      row.className = 'log-row';
      const cls = entry.ok ? 'ok' : 'er';
      const who = entry.printer ? ` → ${esc(entry.printer)}` : '';
      const what = entry.auto ? 'auto' : 'manual';
      row.innerHTML = `<span class="${cls}">${fmtTime(entry.at)}</span> #${esc(entry.orderId)} ${what}${who} ${entry.ok ? `✓ ${entry.ms}ms` : '✗ ' + esc(entry.error || 'failed')}`;
      wrap.appendChild(row);
    }
  } catch { /* ignore */ }
}

// ---------- toast ----------
let toastTimer = null;
function toast(msg, good) {
  const t = $('#toast');
  t.textContent = msg;
  t.style.background = good ? 'var(--brand)' : 'var(--red)';
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (t.hidden = true), good ? 4500 : 7000);
}

// ---------- beep ----------
let audioCtx = null;
function ensureAudio() {
  try {
    audioCtx = audioCtx || new (window.AudioContext || window.webkitAudioContext)();
    if (audioCtx.state === 'suspended') audioCtx.resume();
  } catch { /* ignore */ }
}
document.addEventListener('pointerdown', ensureAudio, { once: false });
function beep() {
  ensureAudio();
  if (!audioCtx || audioCtx.state !== 'running') return;
  const now = audioCtx.currentTime;
  [0, 0.18, 0.36].forEach((at, i) => {
    const osc = audioCtx.createOscillator();
    const gain = audioCtx.createGain();
    osc.connect(gain);
    gain.connect(audioCtx.destination);
    osc.frequency.value = i === 2 ? 1320 : 990;
    gain.gain.setValueAtTime(0.001, now + at);
    gain.gain.exponentialRampToValueAtTime(0.22, now + at + 0.02);
    gain.gain.exponentialRampToValueAtTime(0.001, now + at + 0.14);
    osc.start(now + at);
    osc.stop(now + at + 0.16);
  });
}

// ---------- events ----------
function wireEvents() {
  const es = new EventSource('/api/events');
  es.onmessage = (ev) => {
    let msg;
    try { msg = JSON.parse(ev.data); } catch { return; }
    if (msg.type === 'new') {
      toast(`New order${msg.orderIds.length > 1 ? 's' : ''} — printing to the kitchen!`);
      beep();
      loadOrders();
      loadStatus();
    } else if (msg.type === 'boot') {
      toast('Connected. Watching for new orders…');
    } else if (msg.type === 'error') {
      toast(`Cannot reach the website: ${msg.message}`, false);
      loadStatus();
    } else if (msg.type === 'printed') {
      loadStatus();
    } else if (msg.type === 'printError') {
      toast(`Could not print #${msg.orderId}: ${msg.message}`, false);
      loadStatus();
    } else if (msg.type === 'tick') {
      loadStatus();
    } else if (msg.type === 'shop') {
      loadStatus();
    }
  };
  es.onerror = () => {
    $('#statusDot').className = 'dot off';
  };
}

// ---------- bindings ----------
$('#refreshOrders').addEventListener('click', loadOrders);
$('#scanBtn').addEventListener('click', runScan);
$('#addForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  await fetch('/api/printers', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      name: $('#pName').value.trim(),
      host: $('#pHost').value.trim(),
      port: Number($('#pPort').value) || 9100
    })
  });
  $('#pName').value = '';
  $('#pHost').value = '';
  $('#pPort').value = '9100';
  toast('Printer added — test it now, then set it as target.', true);
  await loadPrinters();
});
$('#settingsForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const r = await fetch('/api/settings', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      sourceBaseUrl: $('#sUrl').value.trim(),
      pollSeconds: Number($('#sSec').value) || 60,
      pollClosedSeconds: Number($('#sClosed').value) || 1800
    })
  });
  const ok = $('#settingsOk');
  if (r.ok) {
    ok.textContent = 'Saved.';
    setTimeout(() => (ok.textContent = ''), 3500);
  } else {
    ok.textContent = 'Could not save.';
  }
  await loadStatus();
  renderLog();
});

// ---------- loop ----------
loadStatus().then(() => {
  renderStatus();
  renderPrinters();
  renderSettingsForm();
  renderLog();
});
loadOrders();
wireEvents();
setInterval(() => { loadStatus(); loadOrders(); renderLog(); }, 15000);