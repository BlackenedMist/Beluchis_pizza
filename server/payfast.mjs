// -----------------------------------------------------------------------
// PayFast (www.payfast.co.za) request signing.
//
// PayFast authenticates a request with an MD5 signature built from the
// url-encoded merchant id, merchant key, return url, notify url, customer
// name, email, amount, item name and the payment method id - the payment
// method id is signed twice - with the merchant passphrase appended raw at
// the end. When the merchant has not set a passphrase of their own, the
// merchant key doubles as the passphrase.
//
// The same construction works in both directions: we sign the checkout fields
// we send to PayFast, and we re-compute the signature from the fields PayFast
// sends back to prove the notification really came from PayFast.
// -----------------------------------------------------------------------

import crypto from "node:crypto";

// PHP's urlencode() - what PayFast's own sample code uses. It differs from
// encodeURIComponent in two ways: a space becomes "+" and !'()* are escaped.
export const payfastUrlEncode = (value) =>
  encodeURIComponent(String(value ?? ""))
    .replace(/%20/g, "+")
    .replace(/[!'()*]/g, (c) => "%" + c.charCodeAt(0).toString(16).toUpperCase());

// The fields PayFast signs, in the exact order it expects them.
export const PAYFAST_SIGNED_FIELDS = [
  "merchant_id",
  "merchant_key",
  "return_url",
  "notify_url",
  "name",
  "email",
  "amount",
  "item_name",
  "m_payment_id",
];

const readParam = (params, key) => {
  if (!params) return "";
  if (typeof params.get === "function") return params.get(key) ?? "";
  return params[key] ?? "";
};

// Sign the given fields with the merchant passphrase.
export const payfastSignature = (fields, passphrase) => {
  const parts = PAYFAST_SIGNED_FIELDS.map((field) => payfastUrlEncode(fields?.[field]));
  // The payment method id is part of the signature twice.
  parts.push(payfastUrlEncode(fields?.m_payment_id));
  return crypto
    .createHash("md5")
    .update(parts.join("") + String(passphrase ?? ""))
    .digest("hex");
};

// Build the field set for a checkout redirect to PayFast. The amount is in
// Rand with two decimals, the way PayFast expects it.
export const payfastCheckoutFields = ({
  merchantId,
  merchantKey,
  passphrase,
  returnUrl,
  notifyUrl,
  reference,
  amount,
  name = "",
  email = "",
  itemName = "Beluchis order",
  paymentMethod = "",
}) => {
  const fields = {
    merchant_id: String(merchantId ?? ""),
    merchant_key: String(merchantKey ?? ""),
    return_url: String(returnUrl ?? ""),
    notify_url: String(notifyUrl ?? ""),
    name: String(name || "").trim(),
    email: String(email || "").trim(),
    amount: Number(amount || 0).toFixed(2),
    item_name: String(itemName || "Beluchis order"),
    // Empty means "offer whatever the merchant enabled in the PayFast dashboard".
    m_payment_id: String(paymentMethod || ""),
    reference: String(reference ?? ""),
  };
  fields.signature = payfastSignature(fields, passphrase);
  return fields;
};

// Pull the signed fields out of an incoming notification - PayFast posts them
// all back - so we can re-compute the signature.
export const payfastFieldsFromParams = (params) => {
  const out = {};
  for (const field of PAYFAST_SIGNED_FIELDS) out[field] = String(readParam(params, field) ?? "");
  return out;
};

// Verify a signature PayFast sent us. The comparison walks both strings in
// full so a wrong signature cannot be discovered a character at a time.
export const validPayfastSignature = (params, passphrase) => {
  const given = String(readParam(params, "signature") || "").trim().toLowerCase();
  if (!/^[0-9a-f]{32}$/.test(given)) return false;
  const expected = payfastSignature(payfastFieldsFromParams(params), passphrase);
  let diff = 0;
  for (let i = 0; i < expected.length; i += 1) diff |= expected.charCodeAt(i) ^ given.charCodeAt(i);
  return diff === 0;
};
