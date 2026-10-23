// -----------------------------------------------------------------------
// PayFast (www.payfast.co.za) request signing.
//
// PayFast authenticates a checkout request with an MD5 signature built from
// the submitted fields, in the order they appear in PayFast's field list:
//
//   merchant_id=10000100&merchant_key=...&return_url=...&...
//   &passphrase=<passphrase>
//
// Values are PHP-style URL encoded (a space becomes "+"), blank fields are
// skipped, and the optional passphrase is appended as its own key/value pair.
// The same construction, using the fields in the order PayFast posts them,
// verifies an Instant Transaction Notification (ITN).
// -----------------------------------------------------------------------

import crypto from "node:crypto";

// PHP's urlencode() - what PayFast's own sample code uses. It differs from
// encodeURIComponent in two ways: a space becomes "+" and !'()*~ are escaped.
export const payfastUrlEncode = (value) =>
  encodeURIComponent(String(value ?? ""))
    .replace(/%20/g, "+")
    .replace(/[!'()*~]/g, (c) => "%" + c.charCodeAt(0).toString(16).toUpperCase());

// The fields PayFast signs for a checkout request, in the exact order its
// documentation lists them. `passphrase` is handled separately so it is only
// added when the merchant actually set one.
export const PAYFAST_SIGNED_FIELDS = [
  "merchant_id",
  "merchant_key",
  "return_url",
  "cancel_url",
  "notify_url",
  "notify_method",
  "name_first",
  "name_last",
  "email_address",
  "cell_number",
  "m_payment_id",
  "amount",
  "item_name",
  "item_description",
  "custom_int1",
  "custom_int2",
  "custom_int3",
  "custom_int4",
  "custom_int5",
  "custom_str1",
  "custom_str2",
  "custom_str3",
  "custom_str4",
  "custom_str5",
  "email_confirmation",
  "confirmation_address",
  "currency",
  "payment_method",
];

const readParam = (params, key) => {
  if (!params) return "";
  if (typeof params.get === "function") return params.get(key) ?? "";
  return params[key] ?? "";
};

const entriesOf = (params) => {
  if (!params) return [];
  if (typeof params.entries === "function") return [...params.entries()];
  return Object.entries(params);
};

// Build the MD5 signature from an ordered list of [key, value] pairs.
const signatureFromEntries = (entries, passphrase) => {
  const parts = entries
    .filter(([key, value]) => key !== "signature" && String(value ?? "") !== "")
    .map(([key, value]) => `${key}=${payfastUrlEncode(value)}`);
  const pass = String(passphrase ?? "");
  if (pass !== "") parts.push(`passphrase=${payfastUrlEncode(pass)}`);
  return crypto.createHash("md5").update(parts.join("&")).digest("hex");
};

// Signature for a checkout request. Fields are signed in PayFast's documented
// order, and only fields PayFast knows about are included.
export const payfastSignature = (fields, passphrase) => {
  const entries = PAYFAST_SIGNED_FIELDS
    .map((field) => [field, fields?.[field]])
    .filter(([, value]) => String(value ?? "") !== "");
  return signatureFromEntries(entries, passphrase);
};

// Signature for an incoming ITN. PayFast posts the fields in the order it
// signed them, so preserve that order - do not sort or filter by a field list.
export const payfastItnSignature = (params, passphrase) =>
  signatureFromEntries(entriesOf(params), passphrase);

// Build the field set for a checkout redirect to PayFast. The amount is in
// Rand with two decimals, the way PayFast expects it.
export const payfastCheckoutFields = ({
  merchantId,
  merchantKey,
  passphrase,
  returnUrl,
  cancelUrl,
  notifyUrl,
  reference,
  amount,
  firstName = "",
  lastName = "",
  email = "",
  itemName = "Beluchis order",
  paymentMethod = "",
}) => {
  const fields = {
    merchant_id: String(merchantId ?? ""),
    merchant_key: String(merchantKey ?? ""),
    return_url: String(returnUrl ?? ""),
    cancel_url: String(cancelUrl ?? ""),
    notify_url: String(notifyUrl ?? ""),
    name_first: String(firstName || "").trim(),
    name_last: String(lastName || "").trim(),
    email_address: String(email || "").trim(),
    // Our order reference. PayFast echoes this back in the ITN as m_payment_id.
    m_payment_id: String(reference ?? ""),
    amount: Number(amount || 0).toFixed(2),
    item_name: String(itemName || "Beluchis order"),
  };
  // Empty means "offer whatever the merchant enabled in the PayFast dashboard".
  if (String(paymentMethod || "") !== "") fields.payment_method = String(paymentMethod);
  fields.signature = payfastSignature(fields, passphrase);
  return fields;
};

// Pull the fields PayFast signed out of an incoming notification - PayFast
// posts them all back - so we can re-compute the signature.
export const payfastFieldsFromParams = (params) => {
  const out = {};
  for (const [key, value] of entriesOf(params)) {
    if (key !== "signature") out[key] = String(value ?? "");
  }
  return out;
};

// Verify a signature PayFast sent us. The comparison walks both strings in
// full so a wrong signature cannot be discovered a character at a time.
export const validPayfastSignature = (params, passphrase) => {
  const given = String(readParam(params, "signature") || "").trim().toLowerCase();
  if (!/^[0-9a-f]{32}$/.test(given)) return false;
  const expected = payfastItnSignature(params, passphrase);
  let diff = 0;
  for (let i = 0; i < expected.length; i += 1) diff |= expected.charCodeAt(i) ^ given.charCodeAt(i);
  return diff === 0;
};
