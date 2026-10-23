#!/usr/bin/env node
// PayGate PayWeb3 signing regression test.
//
//   node scripts/paygate-selftest.mjs          # offline checks only
//   node scripts/paygate-selftest.mjs --live   # also open a real R1 transaction
//
// The live check only calls /payweb3/initiate.trans. No money moves unless
// somebody opens the returned process page and enters card details.
import {
  paygateInitiateFields,
  paygateNotifyChecksum,
  paygateOutcome,
  paygateRedirectChecksum,
  paygateReturnChecksum,
} from "../server/paygate.mjs";

const SECRET = "secret";
let failures = 0;
const check = (name, ok, detail = "") => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  (${detail})` : ""}`);
  if (!ok) failures += 1;
};

// 1. Initiate checksum, using the sample values from PayGate's docs. The
//    empty NOTIFY_URL adds nothing to the checksum, so it matches the sample.
const initiate = paygateInitiateFields({
  paygateId: "10011072130",
  key: SECRET,
  reference: "pgtest_123456789",
  amountCents: 3299,
  email: "customer@paygate.co.za",
  returnUrl: "https://my.return.url/page",
  notifyUrl: "",
  transactionDate: new Date("2020-01-01T12:00:00Z"),
});
check(
  "initiate checksum matches PayGate docs",
  initiate.CHECKSUM === "0864eea1dcce28ba95a52d71dec683cd",
  initiate.CHECKSUM
);
check(
  "initiate fields are in checksum order",
  Object.keys(initiate)
    .filter((k) => k !== "CHECKSUM")
    .join(",") ===
    "PAYGATE_ID,REFERENCE,AMOUNT,CURRENCY,RETURN_URL,TRANSACTION_DATE,LOCALE,COUNTRY,EMAIL,NOTIFY_URL"
);

// 2. Initiate response / browser redirect checksum.
const redirect = paygateRedirectChecksum({
  paygateId: "10011072130",
  key: SECRET,
  payRequestId: "23B785AE-C96C-32AF-4879-D2C9363DB6E8",
  reference: "pgtest_123456789",
});
check(
  "redirect checksum matches PayGate docs",
  redirect === "b41a77f83a275a849f23e30b4666e837",
  redirect
);

// 3. Notify checksum, built from the fields in the order PayGate posts them.
const notify = new URLSearchParams({
  PAYGATE_ID: "10011072130",
  PAY_REQUEST_ID: "23B785AE-C96C-32AF-4879-D2C9363DB6E8",
  REFERENCE: "pgtest_123456789",
  TRANSACTION_STATUS: "1",
  RESULT_CODE: "990017",
  AUTH_CODE: "5T8A0Z",
  CURRENCY: "ZAR",
  AMOUNT: "3299",
  RESULT_DESC: "Auth Done",
  TRANSACTION_ID: "78705178",
  RISK_INDICATOR: "AX",
  PAY_METHOD: "CC",
  PAY_METHOD_DETAIL: "Visa",
  CHECKSUM: "f57ccf051307d8d0a0743b31ea379aa1",
});
const notifyChecksum = paygateNotifyChecksum(notify.toString(), SECRET);
check(
  "notify checksum matches PayGate docs",
  notifyChecksum === "f57ccf051307d8d0a0743b31ea379aa1",
  notifyChecksum
);

const tampered = new URLSearchParams(notify);
tampered.set("AMOUNT", "100");
check("tampered notify rejected", paygateNotifyChecksum(tampered.toString(), SECRET) !== notifyChecksum);

// 4. Return-to-merchant checksum.
const returned = paygateReturnChecksum({
  paygateId: "10011072130",
  key: SECRET,
  payRequestId: "23B785AE-C96C-32AF-4879-D2C9363DB6E8",
  transactionStatus: "1",
  reference: "pgtest_123456789",
});
check("return checksum matches expected", returned === "4d6f22d0abdf222e3c9559d2383c12e2", returned);

// 5. Status mapping. Only definitive outcomes may fail an order.
check("status 1 is paid", paygateOutcome("1") === "paid");
check("status 2 is failed", paygateOutcome("2") === "failed");
check("status 3 is failed", paygateOutcome("3") === "failed");
check("status 4 is failed", paygateOutcome("4") === "failed");
check("status 7 is failed", paygateOutcome("7") === "failed");
check("status 0 stays pending", paygateOutcome("0") === "pending");
check("status 5 stays pending", paygateOutcome("5") === "pending");

if (process.argv.includes("--live")) {
  const paygateId = process.env.PAYGATE_ID || "";
  const key = process.env.PAYGATE_KEY || "";
  const endpoint = (process.env.PAYGATE_ENDPOINT || "https://secure.paygate.co.za").replace(/\/+$/, "");
  const origin = (process.env.PUBLIC_BASE_URL || "https://beluchis.co.za").replace(/\/+$/, "");
  if (!paygateId || !key) {
    check("live credentials present", false, "set PAYGATE_ID and PAYGATE_KEY");
  } else {
    const reference = `BELU-SELFTEST-${Date.now().toString(36).toUpperCase()}`;
    const fields = paygateInitiateFields({
      paygateId,
      key,
      reference,
      amountCents: 100,
      email: "selftest@beluchis.co.za",
      returnUrl: `${origin}/paygate/return`,
      notifyUrl: `${origin}/paygate/notify`,
    });
    try {
      console.log(`\nOpening a real R1.00 PayGate transaction at ${endpoint} ...`);
      const res = await fetch(`${endpoint}/payweb3/initiate.trans`, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams(fields).toString(),
      });
      const text = await res.text();
      const params = new URLSearchParams(text);
      const error = params.get("ERROR") || params.get("RESULT_DESC");
      const payRequestId = params.get("PAY_REQUEST_ID") || "";
      check("live initiate accepted", res.ok && !error && Boolean(payRequestId), error || `HTTP ${res.status}`);
      if (payRequestId) {
        const expected = paygateRedirectChecksum({ paygateId, key, payRequestId, reference });
        check(
          "live initiate checksum valid",
          String(params.get("CHECKSUM") || "").toLowerCase() === expected,
          params.get("CHECKSUM") || "missing"
        );
        check("live merchant matches", String(params.get("PAYGATE_ID")) === String(paygateId));
        check("live reference matches", String(params.get("REFERENCE")) === reference);
        console.log(`PAY_REQUEST_ID=${payRequestId}`);
        console.log(`Process page: ${endpoint}/payweb3/process.trans`);
        console.log("No charge is made unless card details are entered on that page.");
      }
    } catch (err) {
      check("live initiate accepted", false, err.message);
    }
  }
} else {
  console.log("\nOffline checks only. Add --live to open a real R1.00 PayGate transaction.");
}

console.log(`\n${failures === 0 ? "All checks passed." : `${failures} check(s) failed.`}`);
process.exit(failures === 0 ? 0 : 1);
