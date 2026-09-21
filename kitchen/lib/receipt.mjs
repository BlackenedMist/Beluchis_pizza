const WIDTH = 32;

function money(v) {
  return `R${Number(v || 0).toFixed(2)}`.replace(/\.00$/, '');
}

function fmtTime(input) {
  const d = new Date(input);
  if (Number.isNaN(d.getTime())) return String(input);
  try {
    return d.toLocaleString('en-ZA', {
      day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit'
    });
  } catch {
    return String(input);
  }
}

function padCentre(text, width = WIDTH) {
  const t = String(text);
  if (t.length >= width) return t;
  const pad = width - t.length;
  const left = Math.floor(pad / 2);
  return ' '.repeat(left) + t + ' '.repeat(pad - left);
}

function wrap(text, width = WIDTH, indent = '') {
  const words = String(text || '').split(' ').filter(Boolean);
  const out = [];
  let cur = '';
  for (const word of words) {
    const next = cur ? `${cur} ${word}` : word;
    if (next.length > width) {
      if (cur) out.push(indent + cur);
      cur = word.length > width ? word.slice(0, width) : word;
    } else {
      cur = next;
    }
  }
  if (cur) out.push(indent + cur);
  return out.length ? out : [''];
}

function paymentLabel(order) {
  if (order.paymentMethod === 'cod_cash') return 'CASH ON DELIVERY';
  if (order.paymentMethod === 'cod_card') return 'CARD ON DELIVERY';
  if (order.paymentMethod === 'paygate') {
    if (order.paymentStatus === 'paid') return 'PAID ONLINE';
    if (order.paymentStatus === 'failed') return 'PAYMENT FAILED';
    return 'PAYMENT PENDING';
  }
  return '';
}

const rule = { text: '-'.repeat(WIDTH), align: 'center' };

function customerName(customer) {
  if (!customer) return '';
  return [customer.firstName, customer.lastName].filter(Boolean).join(' ');
}

export function buildReceipt(order) {
  const segs = [];
  segs.push({ text: padCentre('BELUCHIS'), align: 'center', bold: true });
  segs.push({ text: padCentre('KITCHEN SLIP'), align: 'center' });
  segs.push(rule);
  segs.push({ text: `ORDER #${order.id}`, align: 'center', bold: true, size: 2 });
  segs.push(rule);
  segs.push({ text: `Type: ${order.deliveryAddress ? 'DELIVERY' : 'COLLECTION'}`, bold: true });
  segs.push({ text: `Time: ${fmtTime(order.createdAt)}` });
  const pay = paymentLabel(order);
  if (pay) segs.push({ text: `Payment: ${pay}` });
  segs.push(rule);
  segs.push({ text: padCentre('ITEMS'), align: 'center', bold: true });
  for (const item of order.items || []) {
    const head = `${item.quantity}x ${item.itemName || 'Item'}${item.sizeLabel ? ` (${item.sizeLabel})` : ''}`;
    const lines = wrap(head);
    lines.forEach((line, i) => segs.push({ text: line, bold: true }));
    if (item.extras) {
      try {
        for (const extra of JSON.parse(item.extras)) {
          segs.push({ text: `   + ${extra.name || extra}` });
        }
      } catch { /* ignore */ }
    }
    segs.push({ text: `     = ${money(item.total)}` });
    segs.push({ text: '' });
  }
  segs.push(rule);
  if (order.notes) {
    segs.push({ text: padCentre('NOTE'), align: 'center', bold: true, size: 2 });
    for (const line of wrap(order.notes)) segs.push({ text: line, bold: true });
    segs.push(rule);
  }
  const name = customerName(order.customer);
  if (name) segs.push({ text: `Customer: ${name}` });
  if (order.customer?.cellphone) segs.push({ text: `Tel: ${order.customer.cellphone}` });
  if (order.deliveryAddress) {
    for (const line of wrap(order.deliveryAddress, WIDTH, 'To: ')) segs.push({ text: line });
  }
  if (order.discountAmount > 0) {
    segs.push({ text: `Subtotal: ${money(order.total)}` });
    segs.push({ text: `Discount: -${money(order.discountAmount)}` });
  }
  segs.push({ text: `TOTAL PAYABLE  ${money(order.grandTotal ?? order.total)}`, align: 'center', bold: true, size: 2 });
  segs.push({ text: '', align: 'center' });
  segs.push({ text: 'Thank you for your order', align: 'center' });
  segs.push({ text: '', align: 'center' });
  return segs;
}

export function segsToText(segments) {
  return segments
    .map((s) => (s.align === 'center' ? padCentre(s.text) : s.text))
    .join('\n');
}