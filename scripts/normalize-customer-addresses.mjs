// scripts/normalize-customer-addresses.mjs
// One-time reconciliation of CustomerAddress rows:
//   1. collapse exact duplicates (same normalized label + address) -> keep default/oldest
//   2. rename same-label/different-address rows to "Home 2", "Home 3", ...
//   3. if a customer still has more than 3, keep default + 2 oldest and archive
//      the rest to a JSON backup (only with --apply)
//   4. ensure exactly one default per customer
//
// Dry-run by default. Pass --apply to write changes (writes a JSON backup first).
// Usage: node scripts/normalize-customer-addresses.mjs [--apply] [--db-url=file:./dev.db]
import { PrismaClient } from "@prisma/client";
import fs from "node:fs";
import path from "node:path";

const apply = process.argv.includes("--apply");
const dbArg = process.argv.find((a) => a.startsWith("--db-url="));
if (dbArg) process.env.DATABASE_URL = dbArg.split("=").slice(1).join("=");

const prisma = new PrismaClient();

const norm = (s) => String(s == null ? "" : s).trim().replace(/\s+/g, " ");
const labelKey = (s) => norm(s).toLowerCase();

function uniqueName(base, used) {
  let candidate = base;
  let n = 2;
  while (used.has(labelKey(candidate))) {
    candidate = base + " " + n;
    n += 1;
  }
  return candidate;
}

async function main() {
  const customers = await prisma.customer.findMany({ select: { id: true } });
  const report = [];
  const archived = [];

  for (const c of customers) {
    const rows = await prisma.customerAddress.findMany({
      where: { customerId: c.id },
      orderBy: [{ isDefault: "desc" }, { createdAt: "asc" }],
    });
    if (!rows.length) continue;

    // 1. exact-duplicate collapse
    const seenExact = new Map();
    const keep = [];
    const dropExact = [];
    for (const r of rows) {
      const key = labelKey(r.label) + "\u0001" + norm(r.address).toLowerCase() + "\u0001" + (r.lat == null ? "" : r.lat) + "," + (r.lng == null ? "" : r.lng);
      if (seenExact.has(key)) {
        // keep the default/oldest already in keep
        dropExact.push(r);
      } else {
        seenExact.set(key, r);
        keep.push(r);
      }
    }

    // 2. rename same-label/different-address rows to unique names
    const usedLabels = new Set();
    const renamed = [];
    for (const r of keep) {
      const base = norm(r.label) || "Home";
      if (usedLabels.has(labelKey(base))) {
        // find a free variant
        let n = 2;
        let cand = base + " " + n;
        while (usedLabels.has(labelKey(cand))) { n += 1; cand = base + " " + n; }
        renamed.push({ row: r, newLabel: cand });
        usedLabels.add(labelKey(cand));
      } else {
        usedLabels.add(labelKey(base));
      }
    }
    const renameMap = new Map(renamed.map((x) => [x.row.id, x.newLabel]));

    // 3. trim to 3 (default + oldest)
    let ordered = keep.slice(); // already default-first then createdAt asc
    // ensure default first
    ordered.sort((a, b) => (b.isDefault === a.isDefault ? 0 : (b.isDefault ? 1 : -1)) || (new Date(a.createdAt) - new Date(b.createdAt)));
    const toArchive = ordered.length > 3 ? ordered.slice(3) : [];
    const toKeep = ordered.slice(0, 3);

    // 4. ensure exactly one default among kept
    let hasDefault = toKeep.some((r) => r.isDefault);
    if (!hasDefault && toKeep.length) toKeep[0].isDefault = true;
    // if multiple defaults, keep only the first
    let seenDef = false;
    for (const r of toKeep) {
      if (r.isDefault) {
        if (seenDef) r.isDefault = false;
        else seenDef = true;
      }
    }

    const changes = [];
    for (const r of dropExact) changes.push({ action: "drop-exact-duplicate", id: r.id, label: r.label });
    for (const x of renamed) changes.push({ action: "rename", id: x.row.id, from: x.row.label, to: x.newLabel });
    for (const r of toArchive) { changes.push({ action: "archive-over-limit", id: r.id, label: r.label }); archived.push({ customerId: c.id, ...r }); }

    if (changes.length) {
      report.push({ customerId: c.id, changes });
    }

    if (apply) {
      await prisma.$transaction(async (tx) => {
        for (const r of dropExact) await tx.customerAddress.delete({ where: { id: r.id } });
        for (const x of renamed) await tx.customerAddress.update({ where: { id: x.row.id }, data: { label: x.newLabel } });
        for (const r of toArchive) await tx.customerAddress.delete({ where: { id: r.id } });
        for (const r of toKeep) {
          await tx.customerAddress.update({ where: { id: r.id }, data: { isDefault: r.isDefault } });
        }
      });
    }
  }

  if (apply && archived.length) {
    const dir = path.join("scripts", "backups");
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, "addresses-archived-" + new Date().toISOString().replace(/[:.]/g, "-") + ".json");
    fs.writeFileSync(file, JSON.stringify(archived, null, 2));
    console.log("Archived " + archived.length + " rows to " + file);
  }

  console.log(JSON.stringify({ mode: apply ? "apply" : "dry-run", customersWithChanges: report.length, report }, null, 2));
}

main()
  .catch((e) => { console.error(e); process.exit(1); })
  .finally(() => prisma.$disconnect());
