// Regression check for the account/invite/zone fixes.
// Uses a THROWAWAY COPY of dev.db and a private port — never touches live data.
//   node scripts/verify-auth-fixes.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { PrismaClient } from "@prisma/client";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const dbPath = path.join(os.tmpdir(), `beluchis-auth-verify-${process.pid}.db`);
const DATABASE_URL = `file:${dbPath.replace(/\\/g, "/")}`;
const PORT = 3199;
const base = `http://127.0.0.1:${PORT}`;
const email = `legacy-verify-${process.pid}@example.com`;
const phoneEmail = `phone-verify-${process.pid}@example.com`;
const phone = "+27000000002";

fs.copyFileSync(path.join(root, "dev.db"), dbPath);
process.env.DATABASE_URL = DATABASE_URL;

const post = async (url, body) => {
  const res = await fetch(base + url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return {
    status: res.status,
    body: await res.json().catch(() => ({})),
    cookie: (res.headers.get("set-cookie") || "").split(";")[0],
  };
};

let child;
let failed = false;
const check = (name, ok, detail) => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failed = true;
};

try {
  // Seed an unclaimed account with an email but NO cellphone (the 9-row case).
  const prisma = new PrismaClient({ datasourceUrl: DATABASE_URL });
  await prisma.customer.deleteMany({ where: { email } });
  await prisma.customer.create({
    data: {
      firstName: "Legacy",
      lastName: "Verify",
      email,
      cellphone: null,
      username: `verify-legacy-${process.pid}`,
      passwordHash: "x",
      claimedAt: null,
    },
  });
  // A second throwaway account WITH a phone, for the legacy cellphone path.
  await prisma.customer.deleteMany({ where: { email: phoneEmail } });
  await prisma.customer.create({
    data: {
      firstName: "Phone",
      lastName: "Verify",
      email: phoneEmail,
      cellphone: phone,
      username: `verify-phone-${process.pid}`,
      passwordHash: "x",
      claimedAt: null,
    },
  });
  // Force the documented production settings in the throwaway DB, including
  // BLANK coordinates, so BUG-1's fallback is exercised on every run.
  const prodSettings = {
    "shop.lat": "",
    "shop.lng": "",
    "delivery.freeRadiusKm": "5",
    "delivery.maxRadiusKm": "10",
    "delivery.feeAmount": "85",
    "delivery.beyondFeeAmount": "95",
    "delivery.minOrderAmount": "200",
    "delivery.enabled": "true",
  };
  for (const [key, value] of Object.entries(prodSettings)) {
    await prisma.setting.upsert({ where: { key }, update: { value }, create: { key, value } });
  }
  const dup = await prisma.customer.findFirst({
    where: { email: { not: null }, cellphone: { not: null } },
    select: { email: true },
  });
  await prisma.$disconnect();
  if (!dup) throw new Error("no seeded customer with an email to test the duplicate case");

  child = spawn(process.execPath, ["server/index.mjs"], {
    cwd: root,
    env: { ...process.env, DATABASE_URL, PORT: String(PORT), NODE_ENV: "production", ADMIN_PIN: "verify-pin" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let logs = "";
  child.stdout.on("data", (d) => (logs += d));
  child.stderr.on("data", (d) => (logs += d));

  let ready = false;
  for (let i = 0; i < 60; i++) {
    try {
      if ((await fetch(base + "/api/categories")).ok) { ready = true; break; }
    } catch {}
    await new Promise((r) => setTimeout(r, 200));
  }
  if (!ready) throw new Error(`server did not start:\n${logs}`);

  const register = await post("/api/customer/auth/register", {
    firstName: "New", lastName: "User", cellphone: "+27000000000",
    email: dup.email, password: "pass1234",
  });
  check("duplicate email returns a claim hint, not a 500",
    register.status === 409 && register.body.code === "account_exists",
    `status ${register.status}`);

  const claim = await post("/api/customer/auth/set-password", {
    email, firstName: "Legacy", password: "pass1234",
  });
  check("claim by email works for an account with no phone",
    claim.status === 201 && Boolean(claim.body.customer?.claimedAt),
    `status ${claim.status}`);

  const loginByEmail = await post("/api/customer/auth/login", {
    identifier: email, password: "pass1234",
  });
  check("login works by email for a no-phone account",
    loginByEmail.status === 200 && Boolean(loginByEmail.cookie),
    `status ${loginByEmail.status}`);

  const unknown = await post("/api/customer/auth/login", {
    identifier: `nobody-${process.pid}@example.com`, password: "pass1234",
  });
  check("unknown identifier gets a generic 401",
    unknown.status === 401 && !JSON.stringify(unknown.body).includes("@"),
    `status ${unknown.status}`);

  const reset = await post("/api/customer/auth/reset-password", {
    identifier: email, firstName: "Legacy", password: "reset1234",
  });
  check("reset-password works by email",
    reset.status === 200 && Boolean(reset.body.customer?.claimedAt),
    `status ${reset.status}`);

  const profile = await fetch(base + "/api/customer/profile", {
    method: "PUT",
    headers: { "Content-Type": "application/json", Cookie: reset.cookie },
    body: JSON.stringify({ cellphone: null, email, firstName: "Legacy", lastName: "Verify" }),
  });
  check("profile saves with no cellphone", profile.status === 200, `status ${profile.status}`);

  const phoneClaim = await post("/api/customer/auth/set-password", {
    cellphone: phone, firstName: "Phone", password: "pass1234",
  });
  check("claim by cellphone still works", phoneClaim.status === 201, `status ${phoneClaim.status}`);

  const loginByPhone = await post("/api/customer/auth/login", {
    cellphone: phone, password: "pass1234",
  });
  check("login by cellphone still works (legacy key)",
    loginByPhone.status === 200 && Boolean(loginByPhone.cookie),
    `status ${loginByPhone.status}`);

  const cfg = await (await fetch(base + "/api/delivery/config")).json();
  check("shop centre is Worcester, not (0,0)",
    cfg.shop.lat === -33.646 && cfg.shop.lng === 19.448,
    JSON.stringify(cfg.shop));

  const zones = await (await fetch(base + "/api/delivery/zones")).json();
  const fees = zones.zones.map((z) => `${z.id}:${z.fee}`).join(", ");
  check("zone bands keep the real prices",
    zones.zones.find((z) => z.id === "standard")?.fee === 85 &&
    zones.zones.find((z) => z.id === "beyond")?.fee === 95,
    fees);
} catch (err) {
  console.error("ERROR", err);
  failed = true;
} finally {
  if (child) child.kill("SIGTERM");
  try { fs.unlinkSync(dbPath); } catch {}
}

process.exit(failed ? 1 : 0);
