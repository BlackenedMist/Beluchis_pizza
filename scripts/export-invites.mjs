// Claim-invite sender for imported (unclaimed) WP customers.
//
// Reads every Customer where claimedAt IS NULL AND inviteSentAt IS NULL, renders
// the subject/body from the store settings (same defaults as the server's
// test-invite endpoint) and optionally emails them via server/mail.mjs.
//
//   node --env-file-if-exists=.env scripts/export-invites.mjs --dry-run
//   node --env-file-if-exists=.env scripts/export-invites.mjs --csv invites.csv
//   node --env-file-if-exists=.env scripts/export-invites.mjs --send --limit 50 --yes
//
// Sending is deliberately gated: --send requires --limit (blast N per run) and
// --yes (confirmation). Each successful send marks inviteSentAt so the next run
// picks up where the previous one stopped — daily runs of e.g. --limit 50 keep
// well under any SMTP daily cap while slowly working through the backlog.
//
// Gmail SMTP caps around 500 recipients/day for normal accounts; plan the
// --limit accordingly.

import path from "node:path";
import { PrismaClient } from "@prisma/client";
import { fill, sendMail, MAIL_ENABLED } from "../server/mail.mjs";

const args = process.argv.slice(2);
const has = (f) => args.includes(f);
const val = (f) => {
  const i = args.indexOf(f);
  return i >= 0 ? args[i + 1] : undefined;
};

const SEND = has("--send");
const YES = has("--yes");
const RESEND = has("--resend");
const LIMIT = Number(val("--limit") || 0) || null;
const CSV = val("--csv") || null;

if (!process.env.DATABASE_URL) {
  console.error("DATABASE_URL not set — refusing to run blind. Use --env-file-if-exists=.env.");
  process.exit(1);
}
if (!SEND && !CSV) {
  console.log("dry-run — listing pending invites, nothing sent (pass --send --limit N --yes to mail).");
}

const PUBLIC_BASE_URL = process.env.PUBLIC_BASE_URL || "";
const PUBLIC_ORIGIN = PUBLIC_BASE_URL || "http://localhost:3100";
const INVITE_URL = `${PUBLIC_ORIGIN}/login`;

const DEFAULT_SUBJECT = "Your Beluchis account is ready";
const DEFAULT_BODY =
  "Hi {firstName},\n\nYour Beluchis account is ready. Set your password to start ordering:\n{url}\n\n— The Beluchis team";

const prisma = new PrismaClient();

const setting = async (key, fallback) => {
  const row = await prisma.setting.findUnique({ where: { key } });
  return row?.value ?? fallback;
};

const subjectTpl = await setting("mail.inviteSubject", DEFAULT_SUBJECT);
const bodyTpl = await setting("mail.inviteBody", DEFAULT_BODY);

// Unclaimed customers with an email, newest first.
const customers = await prisma.customer.findMany({
  where: {
    claimedAt: null,
    email: { not: null },
    ...(RESEND ? {} : { inviteSentAt: null }),
  },
  orderBy: { createdAt: "desc" },
  select: { id: true, firstName: true, lastName: true, email: true, cellphone: true, inviteSentAt: true },
});

const pending = RESEND
  ? customers
  : customers.filter((c) => !c.inviteSentAt);

const rows = pending.slice(0, LIMIT ?? undefined);
const firstName = (c) => String(c.firstName || "there").trim();

if (CSV) {
  const out = [
    ["name", "email", "phone", "status"],
    ...rows.map((c) => [
      `${c.firstName} ${c.lastName}`.trim(),
      c.email,
      c.cellphone || "",
      c.inviteSentAt ? "invited" : "pending",
    ]),
  ]
    .map((r) => r.map((v) => `"${String(v).replace(/"/g, '""')}"`).join(","))
    .join("\n");
  await import("node:fs/promises").then((fs) => fs.writeFile(CSV, out + "\n", "utf8"));
  console.log(`csv written: ${CSV} (${rows.length} rows)`);
}

console.log(`
pending:  ${pending.length}   (unclaimed, has email${RESEND ? ", incl. previously invited" : ""})
this run: ${rows.length}   (${LIMIT ? `limited to ${LIMIT}` : "all"})
subject:  ${subjectTpl}
url:      ${INVITE_URL}
body preview:
${rowPreview(rows[0] ?? { firstName: "there" })}`);

function rowPreview(c) {
  return fill(bodyTpl, { firstName: firstName(c), url: INVITE_URL }).split("\n").slice(0, 4).join("\n");
}

if (!SEND) {
  await prisma.$disconnect();
  process.exit(0);
}
if (!LIMIT) {
  console.error("refusing to send without --limit N (blast cap). Re-run with an explicit limit.");
  await prisma.$disconnect();
  process.exit(1);
}
if (!YES) {
  console.error("refusing to send without --yes confirmation.");
  await prisma.$disconnect();
  process.exit(1);
}
if (!MAIL_ENABLED) {
  console.error("SMTP not configured (SMTP_HOST/USER/PASS/MAIL_FROM) — nothing sent.");
  await prisma.$disconnect();
  process.exit(1);
}

let sent = 0;
let failed = 0;
for (const c of rows) {
  const rendered = fill(bodyTpl, { firstName: firstName(c), url: INVITE_URL });
  const out = await sendMail({ to: c.email, subject: fill(subjectTpl, { firstName: firstName(c) }), text: rendered });
  if (out.ok) {
    await prisma.customer.update({ where: { id: c.id }, data: { inviteSentAt: new Date() } });
    sent++;
  } else {
    failed++;
    console.error(`  failed -> ${c.email} (id ${c.id}): ${out.error || "unknown"}`);
  }
  // 1/s pacing keeps us well inside SMTP rate limits; always sleep, even after
  // a failure, so a burst of errors can't hammer the mailer.
  await new Promise((r) => setTimeout(r, 1000));
}

await prisma.$disconnect();
console.log(`\nsend done — ${sent} sent, ${failed} failed. inviteSentAt marked on successes.`);