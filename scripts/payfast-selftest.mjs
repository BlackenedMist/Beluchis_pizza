#!/usr/bin/env node
// PayFast signing regression test.
//
//   node scripts/payfast-selftest.mjs              # offline checks only
//   node scripts/payfast-selftest.mjs --sandbox    # also POST to the sandbox
//
// The sandbox credentials below are PayFast's public test merchant. They are
// not live credentials and cannot take real money.
import {
  payfastCheckoutFields,
  payfastItnSignature,
  payfastUrlEncode,
  validPayfastSignature,
} from "../server/payfast.mjs";

const SANDBOX = Object.freeze({
  id: "10004002",
  key: "q1cd2rdny4a53",
  passphrase: "payfast",
});

let failures = 0;
const check = (name, ok, detail = "") => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  (${detail})` : ""}`);
  if (!ok) failures += 1;
};

// 1. Encoding must match PHP's urlencode(), which PayFast documents.
check("space encodes as +", payfastUrlEncode("a b") === "a+b", payfastUrlEncode("a b"));
check("!'()* are percent-encoded", payfastUrlEncode("!'()*") === "%21%27%28%29%2A", payfastUrlEncode("!'()*"));
check("~ is percent-encoded", payfastUrlEncode("~") === "%7E", payfastUrlEncode("~"));
check("slash remains encoded", payfastUrlEncode("a/b") === "a%2Fb", payfastUrlEncode("a/b"));

// 2. Checkout field construction.
const checkout = payfastCheckoutFields({
  merchantId: SANDBOX.id,
  merchantKey: SANDBOX.key,
  passphrase: SANDBOX.passphrase,
  returnUrl: "https://example.com/payfast/return",
  cancelUrl: "https://example.com/order?payment=cancelled",
  notifyUrl: "https://example.com/payfast/notify",
  reference: "BELU-TEST123",
  amount: 10,
  firstName: "Test",
  lastName: "Buyer",
  email: "test@beluchis.co.za",
  itemName: "Beluchis test order",
});
check("m_payment_id carries our reference", checkout.m_payment_id === "BELU-TEST123", checkout.m_payment_id);
check("amount has two decimals", checkout.amount === "10.00", checkout.amount);
check("name_first is sent", checkout.name_first === "Test", checkout.name_first);
check("name_last is sent", checkout.name_last === "Buyer", checkout.name_last);
check("email_address is sent", checkout.email_address === "test@beluchis.co.za", checkout.email_address);
check("signature is 32 hex characters", /^[0-9a-f]{32}$/.test(checkout.signature), checkout.signature);

const changedAmount = payfastCheckoutFields({
  merchantId: SANDBOX.id,
  merchantKey: SANDBOX.key,
  passphrase: SANDBOX.passphrase,
  returnUrl: "https://example.com/payfast/return",
  cancelUrl: "https://example.com/order?payment=cancelled",
  notifyUrl: "https://example.com/payfast/notify",
  reference: "BELU-TEST123",
  amount: 11,
  firstName: "Test",
  lastName: "Buyer",
  email: "test@beluchis.co.za",
  itemName: "Beluchis test order",
});
check("changing the amount changes the signature", changedAmount.signature !== checkout.signature);

// 3. ITN verification: fields in the order PayFast posts them.
const itn = new URLSearchParams({
  merchant_id: SANDBOX.id,
  merchant_key: SANDBOX.key,
  m_payment_id: "BELU-TEST123",
  pf_payment_id: "123456",
  payment_status: "COMPLETE",
  item_name: "Beluchis test order",
  amount_gross: "10.00",
  amount_fee: "-0.39",
  amount_net: "9.61",
});
itn.set("signature", payfastItnSignature(itn, SANDBOX.passphrase));
check("valid ITN signature accepted", validPayfastSignature(itn, SANDBOX.passphrase));

const tamperedAmount = new URLSearchParams(itn);
tamperedAmount.set("amount_gross", "100.00");
check("tampered amount rejected", !validPayfastSignature(tamperedAmount, SANDBOX.passphrase));

const wrongPassphrase = new URLSearchParams(itn);
check("wrong passphrase rejected", !validPayfastSignature(wrongPassphrase, "not-the-passphrase"));

if (process.argv.includes("--sandbox")) {
  const endpoint = (process.env.PAYFAST_ENDPOINT || "https://sandbox.payfast.co.za").replace(/\/+$/, "");
  const merchantId = process.env.PAYFAST_ID || SANDBOX.id;
  const merchantKey = process.env.PAYFAST_KEY || SANDBOX.key;
  const passphrase = process.env.PAYFAST_PASSPHRASE ?? SANDBOX.passphrase;
  console.log(`\nPosting a signed R10.00 checkout to ${endpoint} ...`);
  const fields = payfastCheckoutFields({
    merchantId,
    merchantKey,
    passphrase,
    returnUrl: "https://example.com/payfast/return",
    cancelUrl: "https://example.com/order",
    notifyUrl: "https://example.com/payfast/notify",
    reference: `BELU-SELFTEST-${Date.now().toString(36).toUpperCase()}`,
    amount: 10,
    firstName: "Sandbox",
    lastName: "Test",
    email: "test@beluchis.co.za",
    itemName: "Beluchis PayFast self-test",
  });
  try {
    const res = await fetch(`${endpoint}/eng/process`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams(fields).toString(),
      redirect: "follow",
    });
    const text = await res.text();
    const signatureMismatch = /does not match submitted signature/i.test(text);
    check(
      "sandbox accepted the signed checkout",
      res.status === 200 && !signatureMismatch,
      `HTTP ${res.status}${signatureMismatch ? ", signature mismatch" : ""}`
    );
  } catch (err) {
    check("sandbox accepted the signed checkout", false, err.message);
  }
} else {
  console.log("\nOffline checks only. Add --sandbox to POST a signed test checkout to PayFast.");
}

console.log(`\n${failures === 0 ? "All checks passed." : `${failures} check(s) failed.`}`);
process.exit(failures === 0 ? 0 : 1);
