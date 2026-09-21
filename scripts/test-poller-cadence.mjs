// StandAlone Option A cadence test — exercises refreshShop()/effectiveSeconds()
// against a live local Beluchis server (http://localhost:3100), incl. the
// closed->open transition that must trigger an immediate catch-up poll.
//
//   STORAGE_DIR=/tmp/opencode/sa-test node scripts/test-poller-cadence.mjs
//
// Prereqs: local server running (`npm start`), admin/1234 creds (dev .env).

import { rmSync } from "node:fs";
import { Poller } from "../StandAlone/lib/poller.mjs";

const BASE = process.env.SOURCE_BASE_URL || "http://localhost:3100";
const BASE_URL = process.env.TEST_BASE_URL || "http://localhost:3100";

// keep creds in sync with server .env / StandAlone defaults
process.env.SOURCE_USERNAME = process.env.SOURCE_USERNAME || "admin";
process.env.SOURCE_PIN = process.env.SOURCE_PIN || "1234";

let pass = 0;
let fail = 0;
const check = (label, ok, detail = "") => {
  if (ok) { pass++; console.log(`  ok  ${label}`); }
  else { fail++; console.log(`  FAIL ${label} ${detail}`); }
};

async function setShopTime(closeTime) {
  // PUT /api/settings needs the admin session cookie
  const login = await fetch(`${BASE_URL}/api/auth/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ username: "admin", pin: "1234" }),
  });
  if (!login.ok) throw new Error(`admin login failed: ${login.status}`);
  const raw = login.headers.get("set-cookie");
  const cookie = (raw || "").split(";")[0];
  const res = await fetch(`${BASE_URL}/api/settings`, {
    method: "PUT",
    headers: { "content-type": "application/json", cookie },
    body: JSON.stringify({ settings: { "shop.closeTime": closeTime } }),
  });
  if (!res.ok) throw new Error(`settings PUT failed: ${res.status} ${await res.text()}`);
}

async function shopOpenNow() {
  const r = await fetch(`${BASE_URL}/api/shop/config`);
  const j = await r.json();
  return Boolean(j && j.open);
}

// Fresh poller, no persistence side-effects.
const poller = new Poller();
poller.settings.pollSeconds = 60;
poller.settings.pollClosedSeconds = 300;

console.log(`target: ${BASE_URL}`);

// --- baseline: server default (10:00-21:00 SAST). If genuinely closed right
// now (before 10:00 or after 21:00 local), still verify effective cadence.
const initialOpen = await shopOpenNow();
console.log(`server says open right now: ${initialOpen}`);

const before = await poller.refreshShop();
check("refreshShop returns previous-state false (no flip on first read)", before === false, `got ${before}`);
check(
  `effectiveSeconds = closed ? pollClosed(300) : poll(60) [server open=${poller.shopData().open}]`,
  poller.effectiveSeconds() === (poller.shopData().open === false ? 300 : 60),
  `got ${poller.effectiveSeconds()}`
);

// --- force closed: closeTime 20:00 → if server open now got 20:39 SAST+ this flips to closed
const wasOpen = poller.shopData().open;
if (wasOpen) {
  await setShopTime("20:00");
  const flipped = await poller.refreshShop();
  check("server flipped closed → refreshShop reports open=false", poller.shopData().open === false, JSON.stringify(poller.shopData()));
  check("effectiveSeconds now pollClosedSeconds (300)", poller.effectiveSeconds() === 300, `got ${poller.effectiveSeconds()}`);
  check("no reopen flag while staying closed", flipped === false, `got ${flipped}`);
}

// --- force open again: transitions closed->open → immediate catch-up poll flag
await setShopTime("23:00");
const reopened = await poller.refreshShop();
check("closed → open: shopData().open true", poller.shopData().open === true, JSON.stringify(poller.shopData()));
check("closed → open: refreshShop returns true (caller polls immediately)", reopened === true, `got ${reopened}`);
check("effectiveSeconds back to pollSeconds (60)", poller.effectiveSeconds() === 60, `got ${poller.effectiveSeconds()}`);

// --- restore default-ish close time
await setShopTime("21:00");

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);