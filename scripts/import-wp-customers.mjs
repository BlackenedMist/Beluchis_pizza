// Import customers from the old WordPress / WooCommerce backup dumps.
//
// Option A (per Beluchis-Prod-Deploy.md §1.4): accounts + contact info ONLY;
// no order history is migrated. Imported rows are unclaimed (passwordless)
// placeholder customers that sign in through the existing set-password flow.
//
// Sources (backupbuddy dump dir, default below):
//   wpsi_28_wc_customer_lookup.sql  — every WooCommerce customer row (guests + accounts)
//   wpsi_28_wc_order_stats.sql      — order rows, used to pick each customer's
//                                     latest order so we can attach a billing phone
//   wpsi_28_postmeta.sql            — 51 MB; streamed once, _billing_phone rows only
//
// Matching/claims mileage is preserved because we reuse the exact same phone
// normalisation the server uses at login/checkout (server/phone.mjs).
//
// Usage:
//   node --env-file-if-exists=.env scripts/import-wp-customers.mjs [--dump DIR] [--dry-run|--apply]
//
// --dry-run  (default) print a summary + sample rows, never touch the DB.
// --apply    insert into the Prisma SQLite DB, skipping customers that already
//            exist (match by email, canonical phone or username).
//
// NEVER run --apply against a production database from a dev laptop.

import path from "node:path";
import fs from "node:fs";
import crypto from "node:crypto";
import bcrypt from "bcryptjs";
import { PrismaClient } from "@prisma/client";
import { loadTableRows, scanDump } from "./lib/sqlrows.mjs";
import { canonicalPhone } from "../server/phone.mjs";

// ---------------------------------------------------------------------------
// Dump schema (verified against the actual backup files)
//   lookup:  customer_id user_id username first_name last_name email
//            date_last_active date_registered country postcode city state
//   orders:  order_id parent_id date_created date_created_gmt num_items_sold
//            total_sales tax_total shipping_total net_total returning_customer
//            status customer_id date_paid date_completed
//   postmeta(meta_id post_id meta_key meta_value) — streamed
// ---------------------------------------------------------------------------

const DEFAULT_DUMP =
  "/home/admin/Documents/NicksWebBuilder/Test_Pizza/backup-beluchis_info-2026_09_04-01_26pm-full-mq3w9647mp/wp-content/uploads/backupbuddy_temp/mq3w9647mp";

const args = process.argv.slice(2);
const argv = (flag) => {
  const i = args.indexOf(flag);
  return i >= 0 ? args[i + 1] : undefined;
};
const DUMP = argv("--dump") || process.env.DUMP_DIR || DEFAULT_DUMP;
const APPLY = args.includes("--apply");
const LOG_LIMIT = 12;

// Throwaway hash — claimed customers replace it via set-password. Produced once
// and shared so the import isn't slow bcrypt-ing a thousand rows.
const THROWAWAY_HASH = bcrypt.hashSync("beluchis-import-" + crypto.randomBytes(8).toString("hex"), 10);

const lookupFile = path.join(DUMP, "wpsi_28_wc_customer_lookup.sql");
const ordersFile = path.join(DUMP, "wpsi_28_wc_order_stats.sql");
const postmetaFile = path.join(DUMP, "wpsi_28_postmeta.sql");

for (const f of [lookupFile, ordersFile, postmetaFile]) {
  if (!fs.existsSync(f)) {
    console.error(`missing dump file: ${f}`);
    process.exit(1);
  }
}

// ---------------------------------------------------------------------------
// Read accounts + orders
// ---------------------------------------------------------------------------
console.log(`[1/4] reading ${path.basename(lookupFile)} …`);
const lookup = loadTableRows(lookupFile);
const accounts = []; // rows with a linked WP login (user_id not null)
const guests = []; // guest-checkout rows (no login, contact info only)
for (const r of lookup) {
  const rec = {
    customerId: String(r[0]),
    userId: r[1] === null || r[1] === "" ? null : String(r[1]),
    username: r[2] || "",
    first: (r[3] || "").trim(),
    last: (r[4] || "").trim(),
    email: (r[5] || "").trim().toLowerCase(),
    lastActive: r[6],
    registered: r[7],
    city: (r[10] || "").trim(),
  };
  (rec.userId ? accounts : guests).push(rec);
}
console.log(`  lookup rows: ${lookup.length} (accounts: ${accounts.length}, guests: ${guests.length})`);

console.log(`[2/4] streaming ${path.basename(postmetaFile)} for _billing_phone …`);
const phoneByOrder = new Map(); // orderId -> phone string
const res = await scanDump(postmetaFile, (table, fields) => {
  if (table !== "wpsi_28_postmeta") return;
  if (fields[2] !== "_billing_phone") return;
  const val = (fields[3] || "").trim();
  if (val) phoneByOrder.set(String(fields[1]), val);
}, { tables: new Set(["wpsi_28_postmeta"]) });
console.log(`  postmeta lines: ${res.lines}, billing phones found: ${phoneByOrder.size}`);

console.log(`[3/4] reading ${path.basename(ordersFile)} (latest order + phone per customer) …`);
const orders = loadTableRows(ordersFile);
const latestByCustomer = new Map(); // customerId -> { orderId, created, status }
const phoneByCustomer = new Map(); // customerId -> phone of most recent order that has one
for (const r of orders) {
  const cust = String(r[11]);
  const created = r[2] || "";
  const cur = latestByCustomer.get(cust);
  if (!cur || created > cur.created) {
    latestByCustomer.set(cust, { orderId: String(r[0]), created, status: r[10] || "" });
  }
  // keep the phone of the newest order that actually carries a billing phone
  const phoneRaw = phoneByOrder.get(String(r[0]));
  if (phoneRaw && (!phoneByCustomer.has(cust) || created > phoneByCustomer.get(cust).created)) {
    phoneByCustomer.set(cust, phoneRaw);
  }
}
console.log(`  order rows: ${orders.length}, customers with an order: ${latestByCustomer.size}`);

// ---------------------------------------------------------------------------
// Build candidate customer list
// ---------------------------------------------------------------------------
const dropped = {
  junk: 0, // nothing to identify with (name+email+phone all empty)
  appinlet: 0, // agency dev accounts
  noContact: 0, // has a name but no email AND no phone => cannot ever be claimed
  dupeEmail: 0,
  dupePhone: 0,
};

const candidates = [];
for (const a of [...accounts, ...guests]) {
  const phone = canonicalPhone(phoneByCustomer.get(a.customerId));
  const latest = latestByCustomer.get(a.customerId);

  const hasName = Boolean(a.first || a.last);
  const hasContact = Boolean(a.email || phone);
  if (!hasName && !hasContact) {
    dropped.junk++;
    continue;
  }
  if (a.email.includes("@appinlet.com")) {
    dropped.appinlet++;
    continue;
  }
  if (!a.email && !phone) {
    dropped.noContact++;
    continue;
  }

  candidates.push({
    firstName: a.first,
    lastName: a.last,
    email: a.email || null,
    cellphone: phone,
    // Registered accounts keep a real-ish username (claim must echo their
    // first name). Guests get the optional-name treatment the set-password
    // flow gives to every existing guest row.
    username: a.userId ? `wp-${a.customerId}` : `guest-wp-${a.customerId}`,
    createdAt: a.registered || a.lastActive || null,
    city: a.city,
    orderId: latest?.orderId || null,
  });
}

// Registered rows win over guest rows that share an email or phone, so the
// richer (real account) record survives dedupe.
candidates.sort((a, b) => (a.username.startsWith("guest-") ? 1 : 0) - (b.username.startsWith("guest-") ? 1 : 0));

// Dedupe — keep the first row per email, then per canonical phone. A row that
// would be a second email (preferred key) is dropped before phone dedupe.
const byEmail = new Map();
const afterEmail = [];
for (const c of candidates) {
  if (c.email) {
    const prev = byEmail.get(c.email);
    if (prev) {
      dropped.dupeEmail++;
      // keep the registered row, absorb contact fields the loser had
      if (!prev.cellphone && c.cellphone) prev.cellphone = c.cellphone;
      if (!prev.lastName && c.lastName) prev.lastName = c.lastName;
      if (!prev.city && c.city) prev.city = c.city;
      continue;
    }
    byEmail.set(c.email, c);
  }
  afterEmail.push(c);
}

const byPhone = new Map();
const final = [];
for (const c of afterEmail) {
  if (c.cellphone) {
    const prev = byPhone.get(c.cellphone);
    if (prev) {
      dropped.dupePhone++;
      if (!prev.email && c.email) prev.email = c.email;
      if (!prev.lastName && c.lastName) prev.lastName = c.lastName;
      continue;
    }
    byPhone.set(c.cellphone, c);
  }
  final.push(c);
}

// ---------------------------------------------------------------------------
// Report
// ---------------------------------------------------------------------------
const withEmail = final.filter((c) => c.email).length;
const withPhone = final.filter((c) => c.cellphone).length;
console.log("\n[4/4] summary");
console.log(JSON.stringify(
  {
    mode: APPLY ? "apply" : "dry-run",
    accounts: accounts.length,
    candidates: candidates.length,
    dropped,
    imported: final.length,
    withEmail,
    withPhone,
    // a row is directly claimable when it has BOTH email and phone
    claimable: final.filter((c) => c.email && c.cellphone).length,
  },
  null,
  2
));

const sample = final
  .slice(0, LOG_LIMIT)
  .map((c) => `  #${c.username}  ${c.firstName || "?"} ${c.lastName || ""}  ${c.email || "-"}  ${c.cellphone || "-"}  ${c.createdAt || "-"}`)
  .join("\n");
console.log(`\nsample (${Math.min(LOG_LIMIT, final.length)} of ${final.length}):\n${sample}`);

if (!APPLY) {
  console.log("\ndry-run only — pass --apply to insert. Never --apply against production from a laptop.");
  process.exit(0);
}

// ---------------------------------------------------------------------------
// Apply
// ---------------------------------------------------------------------------
if (!process.env.DATABASE_URL) {
  console.error("DATABASE_URL not set — refusing to import blind.");
  process.exit(1);
}

const prisma = new PrismaClient();
let created = 0;
let skipped = 0;
let failed = 0;

for (const c of final) {
  const exists = await prisma.customer.findFirst({
    where: {
      OR: [
        ...(c.email ? [{ email: c.email }] : []),
        ...(c.cellphone ? [{ cellphone: c.cellphone }] : []),
        { username: c.username },
      ],
    },
    select: { id: true },
  });
  if (exists) {
    skipped++;
    continue;
  }
  try {
    await prisma.customer.create({
      data: {
        firstName: c.firstName || c.username, // schema requires non-empty
        lastName: c.lastName,
        email: c.email,
        cellphone: c.cellphone,
        username: c.username,
        passwordHash: THROWAWAY_HASH,
        createdAt: c.createdAt ? new Date(c.createdAt.replace(" ", "T")) : new Date(),
        lat: null,
        lng: null,
      },
    });
    created++;
  } catch (err) {
    failed++;
    console.error(`  failed ${c.username}: ${err.message}`);
  }
}

await prisma.$disconnect();
console.log(`\napply done — created ${created}, skipped (exists) ${skipped}, failed ${failed}`);