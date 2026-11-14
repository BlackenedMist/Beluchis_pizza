// Best-effort email sending via SMTP (Gmail App Password in production).
// Never throws into a request handler: every send is try/caught and logged.
//
// Env config:
//   SMTP_HOST (smtp.gmail.com)  SMTP_PORT (587)  SMTP_USER  SMTP_PASS  MAIL_FROM
//
// When SMTP is not configured the module is disabled and sendMail() logs the
// intent instead of erroring — local/dev servers keep working with no creds.

import nodemailer from "nodemailer";

const HOST = process.env.SMTP_HOST || "";
const PORT = Number(process.env.SMTP_PORT) || 587;
const USER = process.env.SMTP_USER || "";
const PASS = process.env.SMTP_PASS || "";
const FROM = process.env.MAIL_FROM || USER;
export const MAIL_ENABLED = Boolean(HOST && USER && PASS && FROM);

let transport = null;

function getTransport() {
  if (!transport) {
    transport = nodemailer.createTransport({ host: HOST, port: PORT, secure: PORT === 465, auth: { user: USER, pass: PASS } });
  }
  return transport;
}

export function mailEnabled() {
  return MAIL_ENABLED;
}

// Simple {token} placeholder replacement (no templating engine needed).
export function fill(template, vars) {
  return String(template ?? "").replace(/\{(\w+)\}/g, (_, k) => (k in vars ? String(vars[k]) : `{${k}}`));
}

export async function sendMail({ to, subject, text, html }) {
  if (!MAIL_ENABLED) {
    console.log(`[mail] DISABLED — would send "${subject}" to ${to}`);
    return { ok: false, disabled: true };
  }
  try {
    const info = await getTransport().sendMail({ from: `"Beluchis" <${FROM}>`, to, subject, text, html });
    console.log(`[mail] sent "${subject}" to ${to} (${info.messageId})`);
    return { ok: true, messageId: info.messageId };
  } catch (err) {
    console.error(`[mail] FAILED "${subject}" to ${to}: ${err.message}`);
    return { ok: false, error: err.message };
  }
}

// ---- Order confirmation -----------------------------------------------------
// order = full prisma order (customer + items included). Text falls back to
// the plain-text body; HTML is a small inline-styled email.
export function buildOrderConfirmation(order) {
  const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  // Prices are stored in Rand, not cents.
  const rand = (v) => Number(v || 0).toFixed(2);
  const items = Array.isArray(order.items) ? order.items : [];
  const displayId = order.dailyNumber || order.id;
  const name = order.customer?.firstName || order.customer?.lastName || "there";
  const pickup = !order.deliveryAddress;
  const paid = order.paymentStatus === "paid";
  const payLabel =
    (order.paymentMethod === "payfast" || order.paymentMethod === "paygate") ? (paid ? "Paid online" : "Payment pending — complete at checkout")
    : order.paymentMethod === "cod_card" ? "Card on delivery"
    : "Cash on delivery";

  const lines = items.map((it) => {
    const extras = it.extras ? JSON.parse(it.extras || "[]") : [];
    const extraTxt = extras.length ? ` (${extras.map((e) => e.name ?? e).join(", ")})` : "";
    return `${it.quantity}x ${it.itemName}${it.sizeLabel ? ` (${it.sizeLabel})` : ""}${extraTxt} — R${rand(it.total)}`;
  });

  const text = [
    `Hi ${name},`,
    "",
    `Thanks — your Beluchis order #${displayId} has been received.`,
    pickup ? "We'll have it ready for collection." : "We're preparing your delivery.",
    "",
    ...lines,
    "",
    ...(order.discountLabel ? [`Discount (${order.discountLabel}): -R${rand(order.discountAmount)}`, ""] : []),
    ...(order.deliveryFee ? [`Delivery fee: R${rand(order.deliveryFee)}`, ""] : []),
    ...(order.tipAmount ? [`Driver tip: R${rand(order.tipAmount)}`, ""] : []),
    `Total: R${rand(order.grandTotal ?? order.total)}`,
    `Payment: ${payLabel}`,
    "",
    "We'll let the kitchen know straight away.",
    "— The Beluchis team",
  ].join("\n");

  const itemRows = lines.map((l) => `<tr><td style="padding:6px 0;border-bottom:1px solid #f0ece6">${esc(l)}</td></tr>`).join("");
  const html = `<!doctype html><html><body style="margin:0;font-family:system-ui,Arial,sans-serif;background:#faf8f5;color:#2a2520">
<div style="max-width:560px;margin:0 auto;padding:24px">
  <div style="background:#b3351f;color:#fff;border-radius:12px 12px 0 0;padding:18px 24px"><strong>Beluchis Pizza</strong></div>
  <div style="background:#fff;border:1px solid #e8e0d5;border-top:0;border-radius:0 0 12px 12px;padding:24px">
    <h2 style="margin:0 0 4px;font-size:18px">Hi ${esc(name)},</h2>
    <p style="margin:0 0 14px;color:#6d6d6d">Thanks — your order <strong>#${esc(displayId)}</strong> has been received. ${pickup ? "We'll have it ready for collection." : "We're preparing your delivery."}</p>
    <table style="width:100%;border-collapse:collapse">${itemRows}</table>
    ${order.discountLabel ? `<p style="margin:10px 0 0">Discount (${esc(order.discountLabel)}): <strong>-R${rand(order.discountAmount)}</strong></p>` : ""}
    ${order.deliveryFee ? `<p style="margin:4px 0 0">Delivery fee: <strong>R${rand(order.deliveryFee)}</strong></p>` : ""}
    ${order.tipAmount ? `<p style="margin:4px 0 0">Driver tip: <strong>R${rand(order.tipAmount)}</strong></p>` : ""}
    <p style="margin:12px 0 0;font-size:16px">Total: <strong>R${rand(order.grandTotal ?? order.total)}</strong></p>
    <p style="margin:4px 0 0;color:#6d6d6d">Payment: ${esc(payLabel)}</p>
    <p style="margin-top:18px;color:#9a8f80;font-size:13px">— The Beluchis team</p>
  </div>
</div></body></html>`;

  return { subject: `Beluchis order #${displayId} received`, text, html };
}

// ---- Specials mailer -------------------------------------------------------
// Builds a plain-text + HTML "specials" newsletter for one recipient. The
// specials come from the DB with their items included; copy is generated the
// same way the storefront advertises them so the owner's offer matches.
export function buildSpecialsEmail({ firstName, specials, subject, message, orderUrl }) {
  const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const rand = (v) => "R" + Number(v || 0);
  const name = firstName || "there";

  const line = (s) => {
    if (s.kind === "pick" || s.kind === "bogo") {
      const buy = Number(s.buyCount || s.count) || 2;
      const pay = Number(s.payCount || Math.max(1, buy - 1));
      const free = Math.max(0, buy - pay);
      return free > 0 ? `Buy ${pay}, get ${free} free` : `Buy ${buy}, pay for ${pay}`;
    }
    if (s.kind === "deal") return `Any ${Number(s.count) || 2} for ${rand(s.price)}`;
    if (s.kind === "bundle") return Number(s.price) > 0 ? `Bundle for ${rand(s.price)}` : "Build your own";
    if (Number(s.price) > 0) return `Just ${rand(s.price)}`;
    return "";
  };

  const list = Array.isArray(specials) ? specials : [];
  const textLines = list.map((s) => {
    const l = line(s);
    return `• ${s.name}${l ? " — " + l : ""}${s.description ? "\n  " + s.description : ""}`;
  });

  const text = [
    `Hi ${name},`,
    "",
    ...(message ? [message, ""] : []),
    ...(list.length ? ["This week at Beluchis:", "", ...textLines, ""] : []),
    ...(orderUrl ? [`Order online: ${orderUrl}`, ""] : []),
    "— The Beluchis team",
  ].join("\n");

  const cardRows = list.map((s) => {
    const l = line(s);
    return `<tr><td style="padding:12px 0;border-bottom:1px solid #f0ece6">
      <div style="font-size:15px;font-weight:700;color:#2a2520">${esc(s.name)}</div>
      ${l ? `<div style="font-size:14px;font-weight:600;color:#b3351f">${esc(l)}</div>` : ""}
      ${s.description ? `<div style="font-size:13px;color:#6d6d6d;margin-top:2px">${esc(s.description)}</div>` : ""}
    </td></tr>`;
  }).join("");

  const html = `<!doctype html><html><body style="margin:0;font-family:system-ui,Arial,sans-serif;background:#faf8f5;color:#2a2520">
<div style="max-width:560px;margin:0 auto;padding:24px">
  <div style="background:#b3351f;color:#fff;border-radius:12px 12px 0 0;padding:18px 24px"><strong>Beluchis Pizza</strong></div>
  <div style="background:#fff;border:1px solid #e8e0d5;border-top:0;border-radius:0 0 12px 12px;padding:24px">
    <h2 style="margin:0 0 4px;font-size:18px">Hi ${esc(name)},</h2>
    ${message ? `<p style="margin:0 0 14px;color:#6d6d6d">${esc(message)}</p>` : ""}
    ${list.length ? `<p style="margin:14px 0 4px;font-size:15px;font-weight:700">This week at Beluchis:</p>
    <table style="width:100%;border-collapse:collapse">${cardRows}</table>` : ""}
    ${orderUrl ? `<p style="margin-top:18px"><a href="${esc(orderUrl)}" style="display:inline-block;background:#b3351f;color:#fff;text-decoration:none;border-radius:8px;padding:11px 22px;font-weight:600;font-size:14px">Order online</a></p>` : ""}
    <p style="margin-top:18px;color:#9a8f80;font-size:13px">— The Beluchis team</p>
  </div>
</div></body></html>`;

  return { subject: subject || "Beluchis specials this week", text, html };
}