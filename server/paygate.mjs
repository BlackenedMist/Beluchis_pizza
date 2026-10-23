// PayGate PayWeb3 (https://secure.paygate.co.za) request signing and
// checksum validation.
//
// PayGate authenticates every request and callback with an MD5 checksum over
// the field values concatenated in a documented order, with the account's
// encryption key appended. The key is used verbatim - it is not base64
// decoded, even when the dashboard displays a base64-looking value.

import crypto from "node:crypto";

export const paygateMd5 = (key, ...parts) =>
  crypto.createHash("md5").update(parts.join("") + key).digest("hex");

// PayWeb3 expects "YYYY-MM-DD HH:MM:SS" in UTC.
export const paygateUtcStamp = (date = new Date()) =>
  date.toISOString().replace("T", " ").replace(/\..+$/, "");

// Fields for POST /payweb3/initiate.trans. Optional fields must only be added
// here (in the documented position) when they are actually sent: the checksum
// is built from the values in this same order.
export const paygateInitiateFields = ({
  paygateId,
  key,
  reference,
  amountCents,
  email = "",
  returnUrl,
  notifyUrl,
  transactionDate = new Date(),
}) => {
  const fields = {
    PAYGATE_ID: String(paygateId),
    REFERENCE: String(reference),
    AMOUNT: String(amountCents),
    CURRENCY: "ZAR",
    RETURN_URL: String(returnUrl),
    TRANSACTION_DATE: paygateUtcStamp(transactionDate),
    LOCALE: "en-za",
    COUNTRY: "ZAF",
    EMAIL: String(email || "").trim(),
    NOTIFY_URL: String(notifyUrl),
  };
  return { ...fields, CHECKSUM: paygateMd5(key, ...Object.values(fields)) };
};

// The initiate response and the browser redirect both use the same checksum:
// PAYGATE_ID + PAY_REQUEST_ID + REFERENCE + key.
export const paygateRedirectChecksum = ({ paygateId, key, payRequestId, reference }) =>
  paygateMd5(key, paygateId, payRequestId, reference);

// Notify callbacks are signed over every posted field in the order PayGate
// sent them (excluding CHECKSUM and empty optional values), plus the key.
// Using the raw body preserves that order.
export const paygateNotifyChecksum = (rawBody, key) => {
  const values = [];
  for (const [name, value] of new URLSearchParams(String(rawBody || ""))) {
    if (name === "CHECKSUM") continue;
    if (value !== "") values.push(value);
  }
  return paygateMd5(key, ...values);
};

// Return-to-merchant is client-initiated and only carries a subset of the
// fields. Its checksum is PAYGATE_ID + PAY_REQUEST_ID + TRANSACTION_STATUS +
// REFERENCE + key.
export const paygateReturnChecksum = ({
  paygateId,
  key,
  payRequestId,
  transactionStatus,
  reference,
}) => paygateMd5(key, paygateId, payRequestId, transactionStatus, reference);

// Transaction status codes:
//   0 not done, 1 approved, 2 declined, 3 cancelled,
//   4 user cancelled, 5 received by PayGate, 7 settlement voided.
export const paygateOutcome = (transactionStatus) => {
  const code = String(transactionStatus ?? "").trim();
  if (code === "1") return "paid";
  if (code === "2" || code === "3" || code === "4" || code === "7") return "failed";
  return "pending";
};
