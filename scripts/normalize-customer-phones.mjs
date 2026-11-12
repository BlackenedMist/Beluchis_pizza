// Normalise legacy Customer.cellphone values to E.164 (+27…).
//
// Older seeds/imports stored human-formatted numbers ("+27 82 555 0123").
// Logins now try both forms, but canonical storage keeps guest checkout from
// creating duplicate customers and makes unique-phone enforcement reliable.
//
// Dry-run by default. Pass --apply to write.
//   node scripts/normalize-customer-phones.mjs
//   node scripts/normalize-customer-phones.mjs --apply
import { PrismaClient } from "@prisma/client";
import { canonicalPhone } from "../server/phone.mjs";

const prisma = new PrismaClient();
const apply = process.argv.includes("--apply");

const rows = await prisma.customer.findMany({
  where: { cellphone: { not: null } },
  select: { id: true, firstName: true, lastName: true, cellphone: true },
});

const changes = [];
const conflicts = [];
const seen = new Map(rows.map((r) => [r.cellphone, r.id]));

for (const row of rows) {
  const next = canonicalPhone(row.cellphone);
  if (!next || next === row.cellphone) continue;
  const owner = seen.get(next);
  if (owner && owner !== row.id) {
    conflicts.push({ ...row, next, owner });
    continue;
  }
  changes.push({ ...row, next });
}

console.log(`customers with a phone: ${rows.length}`);
console.log(`to normalise: ${changes.length}`);
for (const c of changes) console.log(`  #${c.id} ${c.firstName} ${c.lastName}: "${c.cellphone}" -> "${c.next}"`);
if (conflicts.length) {
  console.log(`skipped (canonical number already belongs to another customer): ${conflicts.length}`);
  for (const c of conflicts) console.log(`  #${c.id} "${c.cellphone}" -> "${c.next}" already on #${c.owner}`);
}

if (!apply) {
  console.log("\nDry run. Re-run with --apply to write these changes.");
} else {
  let done = 0;
  for (const c of changes) {
    try {
      await prisma.customer.update({ where: { id: c.id }, data: { cellphone: c.next } });
      done += 1;
    } catch (e) {
      console.warn(`  failed #${c.id}: ${e.message}`);
    }
  }
  console.log(`\nUpdated ${done} customer(s).`);
}

await prisma.$disconnect();
