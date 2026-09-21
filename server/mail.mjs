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
  const items = Array.isArray(order.items) ? order.items : [];
  const name = order.customer?.firstName || order.customer?.lastName || "there";
  const pickup = !order.deliveryAddress;
  const paid = order.paymentStatus === "paid";
  const payLabel =
    order.paymentMethod === "paygate" ? (paid ? "Paid online" : "Payment pending — complete at checkout")
    : order.paymentMethod === "cod_card" ? "Card on delivery"
    : "Cash on delivery";

  const lines = items.map((it) => {
    const extras = it.extras ? JSON.parse(it.extras || "[]") : [];
    const extraTxt = extras.length ? ` (${extras.map((e) => e.name ?? e).join(", ")})` : "";
    return `${it.quantity}x ${it.itemName}${it.sizeLabel ? ` (${it.sizeLabel})` : ""}${extraTxt} — R${((it.total) / 100).toFixed(2)}`;
  });

  const text = [
    `Hi ${name},`,
    "",
    `Thanks — your Beluchis order #${order.id} has been received.`,
    pickup ? "We'll have it ready for collection." : "We're preparing your delivery.",
    "",
    ...lines,
    "",
    ...(order.discountLabel ? [`Discount (${order.discountLabel}): -R${((order.discountAmount) / 100).toFixed(2)}`, ""] : []),
    ...(order.deliveryFee ? [`Delivery fee: R${((order.deliveryFee) / 100).toFixed(2)}`, ""] : []),
    `Total: R${((order.grandTotal ?? order.total) / 100).toFixed(2)}`,
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
    <p style="margin:0 0 14px;color:#6d6d6d">Thanks — your order <strong>#${esc(order.id)}</strong> has been received. ${pickup ? "We'll have it ready for collection." : "We're preparing your delivery."}</p>
    <table style="width:100%;border-collapse:collapse">${itemRows}</table>
    ${order.discountLabel ? `<p style="margin:10px 0 0">Discount (${esc(order.discountLabel)}): <strong>-R${((order.discountAmount) / 100).toFixed(2)}</strong></p>` : ""}
    ${order.deliveryFee ? `<p style="margin:4px 0 0">Delivery fee: <strong>R${((order.deliveryFee) / 100).toFixed(2)}</strong></p>` : ""}
    <p style="margin:12px 0 0;font-size:16px">Total: <strong>R${((order.grandTotal ?? order.total) / 100).toFixed(2)}</strong></p>
    <p style="margin:4px 0 0;color:#6d6d6d">Payment: ${esc(payLabel)}</p>
    <p style="margin-top:18px;color:#9a8f80;font-size:13px">— The Beluchis team</p>
  </div>
</div></body></html>`;

  return { subject: `Beluchis order #${order.id} received`, text, html };
}