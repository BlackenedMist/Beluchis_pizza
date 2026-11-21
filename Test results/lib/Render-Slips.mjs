// Renders one order through both receipt builders and writes every slip artifact.
// Usage: node Render-Slips.mjs <order.json> <output-dir>
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const [orderFile, outDir] = process.argv.slice(2);
if (!orderFile || !outDir) {
  console.error('Usage: node Render-Slips.mjs <order.json> <output-dir>');
  process.exit(2);
}

const order = JSON.parse(fs.readFileSync(orderFile, 'utf8'));
fs.mkdirSync(outDir, { recursive: true });

const builders = [
  ['standalone', 'C:/Beluchis_pizza/StandAlone/lib/receipt.mjs'],
  ['kitchen', 'C:/Beluchis_pizza/kitchen/lib/receipt.mjs'],
];

const texts = {};
for (const [name, file] of builders) {
  const mod = await import(pathToFileURL(file).href);
  const segments = mod.buildReceipt(order);
  const text = mod.segsToText(segments);
  texts[name] = text;
  fs.writeFileSync(path.join(outDir, `receipt-${name}.txt`), text + '\n');
  fs.writeFileSync(path.join(outDir, `segments-${name}.json`), JSON.stringify(segments, null, 2) + '\n');
}

// Mirror of the kitchen-page order card (StandAlone/public/app.js) as text.
function extraLabel(extra) {
  if (!extra || typeof extra !== 'object') return extra == null ? '' : String(extra);
  const label = extra.name || (extra.itemId != null ? `Item #${extra.itemId}` : '');
  if (!label) return '';
  if (/^(FREE|PAID)\b/i.test(label)) return label;
  if (extra.free === true) return `FREE \u2014 ${label}`;
  if (extra.paid === true) return `PAID \u2014 ${label}`;
  return label;
}
const card = [];
card.push(`#${order.dailyNumber || order.id} ${order.deliveryAddress ? 'Delivery' : 'Collection'}`);
for (const item of order.items || []) {
  let name = `${item.itemName || 'Item'}${item.sizeLabel ? ` (${item.sizeLabel})` : ''}`;
  if (Number(item.total) === 0 && Number(item.unitPrice) === 0 && !/^FREE\b/i.test(name)) name = `FREE \u2014 ${name}`;
  card.push(`${item.quantity}x ${name}  R${item.total}`);
  if (item.extras) {
    try {
      for (const extra of JSON.parse(item.extras)) {
        const label = extraLabel(extra);
        if (label) card.push(`   + ${label}`);
      }
    } catch { /* ignore */ }
  }
}
if (order.discountLabel) card.push(`Promotion: ${order.discountLabel}  -R${order.discountAmount}`);
if (order.tipAmount > 0) card.push(`Tip: R${order.tipAmount}`);
card.push(`R${order.grandTotal ?? order.total}`);
fs.writeFileSync(path.join(outDir, 'card.txt'), card.join('\n') + '\n');

const checks = {
  no_object_object: !Object.values(texts).some((t) => t.includes('[object Object]')),
  receipts_match: texts.standalone === texts.kitchen,
  has_paid_label: Object.values(texts).some((t) => t.includes('PAID \u2014')),
  has_free_label: Object.values(texts).some((t) => t.includes('FREE \u2014')),
  has_promotion: !order.discountLabel || Object.values(texts).some((t) => t.includes('Promotion:')),
  has_discount: !(Number(order.discountAmount) > 0) || Object.values(texts).some((t) => t.includes('Discount: -')),
  has_tip: !(Number(order.tipAmount) > 0) || Object.values(texts).some((t) => t.includes('Tip:')),
  has_total: Object.values(texts).some((t) => t.includes(`R${order.grandTotal ?? order.total}`)),
  card_no_doubled_quantity: !card.some((l) => /\d+x\s+\d+x /.test(l)),
  card_no_object: !card.some((l) => l.includes('[object Object]')),
};
fs.writeFileSync(path.join(outDir, 'asserts.json'), JSON.stringify(checks, null, 2) + '\n');

const failed = Object.entries(checks).filter(([, ok]) => !ok).map(([k]) => k);
console.log(JSON.stringify({ folder: path.basename(outDir), failed }));
process.exit(failed.length ? 1 : 0);
