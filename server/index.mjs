import express from "express";
import path from "node:path";
import crypto from "node:crypto";
import fsp from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { PrismaClient } from "@prisma/client";
import bcrypt from "bcryptjs";
import { canonicalPhone } from "./phone.mjs";
import { buildOrderConfirmation, fill, mailEnabled, sendMail } from "./mail.mjs";
import { payfastCheckoutFields, validPayfastSignature } from "./payfast.mjs";
import {
  paygateInitiateFields,
  paygateNotifyChecksum,
  paygateOutcome,
  paygateRedirectChecksum,
  paygateReturnChecksum,
} from "./paygate.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const prisma = new PrismaClient();
const app = express();
const PORT = process.env.PORT || 3100;
const ADMIN_PIN = process.env.ADMIN_PIN || "1234";

// PayGate (PayWeb3) online payment config. Online payment stays disabled until
// both PAYGATE_ID and PAYGATE_KEY are present in the environment.
const PAYGATE_ENDPOINT = process.env.PAYGATE_ENDPOINT || "https://secure.paygate.co.za";
const PAYGATE_ID = process.env.PAYGATE_ID || "";
const PAYGATE_KEY = process.env.PAYGATE_KEY || "";
const PAYGATE_ENABLED = Boolean(PAYGATE_ID && PAYGATE_KEY);

// PayFast online payment config. Stays disabled until both PAYFAST_ID and
// PAYFAST_KEY are present in the environment. PAYFAST_PASSPHRASE is the
// "Salt Passphrase" from the PayFast dashboard and is optional: if it is not
// set, PayFast signs without a passphrase. Never substitute the merchant key.
const PAYFAST_ENDPOINT = (process.env.PAYFAST_ENDPOINT || "https://www.payfast.co.za").replace(/\/+$/, "");
const PAYFAST_ID = process.env.PAYFAST_ID || "";
const PAYFAST_KEY = process.env.PAYFAST_KEY || "";
const PAYFAST_PASSPHRASE = process.env.PAYFAST_PASSPHRASE || "";
const PAYFAST_ENABLED = Boolean(PAYFAST_ID && PAYFAST_KEY);
// Which PayFast payment method to offer ("1" = card, "2" = EFT, ...). Empty
// means "whatever the merchant has enabled in the PayFast dashboard".
const PAYFAST_PAYMENT_METHOD = process.env.PAYFAST_PAYMENT_METHOD || "";
const payfastPassphrase = () => PAYFAST_PASSPHRASE;

// PayGate PayWeb3 is the active online provider. PayFast remains in the server
// only so historical PayFast orders and callbacks can still be reconciled - it
// is never offered to customers.
const onlinePaymentProvider = () => (PAYGATE_ENABLED ? "paygate" : null);

const PUBLIC_BASE_URL = process.env.PUBLIC_BASE_URL || "";
const PUBLIC_ORIGIN = (PUBLIC_BASE_URL || `http://localhost:${PORT}`).replace(/\/+$/, "");

const PAYMENT_METHODS = new Set(["cod_cash", "cod_card", "paygate", "payfast", "pay_at_counter"]);
const PAYMENT_STATUSES = new Set(["pending", "paid", "failed"]);

app.use(express.json({ limit: "8mb" }));
// Keep the raw form body: both PayFast's ITN signature and PayGate's notify
// checksum are computed over the fields in the order they were posted, and
// express's parser may reorder keys.
app.use(
  express.urlencoded({
    extended: true,
    verify: (req, _res, buf) => {
      req.rawBody = buf.toString("utf8");
    },
  })
);
app.use(express.static(path.join(__dirname, "..", "public")));

// -------------------------------------------------------------------- Routes
app.get("/", (_req, res) => res.sendFile(path.join(__dirname, "..", "public", "home.html")));
app.get("/order", (_req, res) => res.sendFile(path.join(__dirname, "..", "public", "menu.html")));
app.get("/menu", (_req, res) => res.redirect(301, "/order"));
app.get("/login", (_req, res) => res.sendFile(path.join(__dirname, "..", "public", "login.html")));
app.get("/portal", (_req, res) => res.sendFile(path.join(__dirname, "..", "public", "customer.html")));
app.get("/preview", (_req, res) => res.redirect(302, "/preview/mobile"));
app.get("/preview/mobile", (_req, res) => res.sendFile(path.join(__dirname, "..", "public", "preview-mobile.html")));
app.get("/preview/portal", (_req, res) => res.sendFile(path.join(__dirname, "..", "public", "preview-portal.html")));
app.get("/admin", (req, res) => {
  if (!getSession(req)) return res.redirect("/login");
  res.sendFile(path.join(__dirname, "..", "public", "admin.html"));
});

app.get("/cashier", (req, res) => {
  if (!getSession(req)) return res.redirect("/login");
  res.sendFile(path.join(__dirname, "..", "public", "cashier.html"));
});

app.get("/driver", (req, res) => {
  if (!getSession(req)) return res.redirect("/login");
  res.sendFile(path.join(__dirname, "..", "public", "driver.html"));
});

const slugify = (s) =>
  String(s || "")
    .toLowerCase()
    .replace(/&/g, "and")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");

const asyncHandler = (fn) => (req, res) =>
  fn(req, res).catch((e) => {
    console.error(e);
    res.status(e.status || 500).json({ error: e.message });
  });

const publicCustomer = ({ passwordHash, ...rest }) => rest;

const publicOrder = ({ customer, ...rest }) => ({ ...rest, customer: customer ? publicCustomer(customer) : null });

const isUniqueViolation = (e) => e.code === "P2002";

const validContact = (email, cellphone) => Boolean(email?.trim() || cellphone?.trim());

// Helper maps / numeric coercion
const nOr = (v, fallback = null) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
};

// Great-circle distance in kilometres (Haversine), for delivery radius checks.
const distanceKm = (lat1, lng1, lat2, lng2) => {
  if (![lat1, lng1, lat2, lng2].every((v) => Number.isFinite(nOr(v)))) return null;
  const toRad = (d) => (Number(d) * Math.PI) / 180;
  const R = 6371;
  const dLat = toRad(Number(lat2) - Number(lat1));
  const dLng = toRad(Number(lng2) - Number(lng1));
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(Number(lat1))) * Math.cos(toRad(Number(lat2))) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
};

const DEFAULT_SETTINGS = {
  "shop.lat": "-33.646",
  "shop.lng": "19.448",
  "delivery.freeRadiusKm": "3",
  "delivery.maxRadiusKm": "10",
  "delivery.feeAmount": "85",
  "delivery.beyondFeeAmount": "95",
  "delivery.minOrderAmount": "200",
  "delivery.enabled": "true",
  "shop.openTime": "10:00",
  "shop.closeTime": "21:00",
  "shop.onlineEnabled": "true",
  "shop.forceOpen": "false",
};

const getSetting = async (key, fallback = null) => {
  try {
    const row = await prisma.setting.findUnique({ where: { key } });
    return row ? row.value : fallback;
  } catch {
    return fallback;
  }
};

const numSetting = async (key, fallback) => {
  const v = await getSetting(key, null);
  return v == null ? fallback : nOr(v, fallback);
};

// Live delivery configuration assembled from the Setting table (never cached).
const getDeliveryConfig = async () => {
  const shopLat = await numSetting("shop.lat", null);
  const shopLng = await numSetting("shop.lng", null);
  const freeRadiusKm = await numSetting("delivery.freeRadiusKm", 3);
  const maxRadiusKm = await numSetting("delivery.maxRadiusKm", 10);
  const feeAmount = await numSetting("delivery.feeAmount", 85);
  const beyondFeeAmount = await numSetting("delivery.beyondFeeAmount", 95);
  const minOrderAmount = await numSetting("delivery.minOrderAmount", 200);
  const enabled = (await getSetting("delivery.enabled", "true")).toLowerCase() === "true";
  return {
    enabled,
    shop: { lat: shopLat, lng: shopLng },
    freeRadiusKm,
    maxRadiusKm,
    feeAmount: Math.max(0, feeAmount),
    beyondFeeAmount: Math.max(0, beyondFeeAmount),
    minOrderAmount: Math.max(0, minOrderAmount),
  };
};

// Shop opening hours (single daily window, shop-local time). South Africa is
// Central Africa Time (CAT), year-round (no DST), so a fixed offset is exact.
const SHOP_TZ_OFFSET_MIN = 120;
const HHMM_RE = /^([01]\d|2[0-3]):([0-5]\d)$/;
const parseHHMM = (v) => {
  const m = HHMM_RE.exec(String(v || "").trim());
  return m ? Number(m[1]) * 60 + Number(m[2]) : null;
};
const shopLocalMinutes = (now = new Date()) =>
  (now.getUTCHours() * 60 + now.getUTCMinutes() + SHOP_TZ_OFFSET_MIN) % 1440;

// Owner-controlled storefront hours: a single daily open/close window plus a
// "forceOpen" override for busy nights, and a master online-ordering switch.
const getShopConfig = async () => {
  const openTime = await getSetting("shop.openTime", "10:00");
  const closeTime = await getSetting("shop.closeTime", "21:00");
  const onlineEnabled = (await getSetting("shop.onlineEnabled", "true")).toLowerCase() === "true";
  const forceOpen = (await getSetting("shop.forceOpen", "false")).toLowerCase() === "true";
  const forceClosed = (await getSetting("shop.forceClosed", "false")).toLowerCase() === "true";
  return { openTime, closeTime, onlineEnabled, forceOpen, forceClosed, onlinePayment: onlinePaymentProvider() };
};

// Live open/closed status. A window that crosses midnight (close < open) is
// supported. Missing/unparseable times and an equal pair are treated as open.
const getShopStatus = async (now = new Date()) => {
  const cfg = await getShopConfig();
  const minutes = shopLocalMinutes(now);
  const openM = parseHHMM(cfg.openTime);
  const closeM = parseHHMM(cfg.closeTime);
  let open;
  if (!cfg.onlineEnabled || cfg.forceClosed) open = false;
  else if (cfg.forceOpen) open = true;
  else if (openM == null || closeM == null || openM === closeM) open = true;
  else if (closeM > openM) open = minutes >= openM && minutes < closeM;
  else open = minutes >= openM || minutes < closeM;
  return { ...cfg, open };
};

// Decide how a delivery request should be handled. Returns:
//   { ok, status, distanceKm, fee, minOrderAmount, standardFee, reason }
// <=freeRadiusKm            -> free *only* when the food subtotal meets
//                              minOrderAmount; below that the standard fee
//                              applies even inside the free radius.
// freeRadiusKm..maxRadiusKm -> feeAmount
// beyond maxRadiusKm        -> beyondFeeAmount (there is no hard cutoff)
// No GPS                    -> unverified; the standard fee applies and the
//                              shop confirms the address/rate with the caller.
const classifyDelivery = async ({ deliveryAddress, lat, lng }) => {
  const cfg = await getDeliveryConfig();
  const hasCoords = Number.isFinite(nOr(lat)) && Number.isFinite(nOr(lng));
  const wantsDelivery = Boolean(deliveryAddress?.trim()) || hasCoords;
  const minOrderAmount = cfg.enabled ? cfg.minOrderAmount : 0;
  const standardFee = cfg.enabled ? cfg.feeAmount : 0;
  if (!wantsDelivery)
    return { ok: true, status: "collection", distanceKm: null, fee: 0, minOrderAmount, standardFee, reason: null };

  // Address only (no GPS captured): can't prove the free radius, so the
  // standard fee applies. The shop confirms the address and rate by phone.
  if (!hasCoords)
    return { ok: true, status: "unverified", distanceKm: null, fee: standardFee, minOrderAmount, standardFee, reason: null };

  if (!cfg.enabled)
    return { ok: true, status: "unverified", distanceKm: null, fee: 0, minOrderAmount, standardFee, reason: "delivery disabled" };

  if (cfg.shop.lat == null || cfg.shop.lng == null)
    return { ok: true, status: "unverified", distanceKm: null, fee: standardFee, minOrderAmount, standardFee, reason: "delivery not configured" };

  const dist = distanceKm(cfg.shop.lat, cfg.shop.lng, lat, lng);
  if (dist == null)
    return { ok: true, status: "unverified", distanceKm: null, fee: standardFee, minOrderAmount, standardFee, reason: "delivery not configured" };

  const rounded = Math.round(dist * 100) / 100;
  if (dist <= cfg.freeRadiusKm)
    return { ok: true, status: "free", distanceKm: rounded, fee: 0, minOrderAmount, standardFee, reason: null };
  if (dist <= cfg.maxRadiusKm)
    return { ok: true, status: "fee", distanceKm: rounded, fee: cfg.feeAmount, minOrderAmount, standardFee, reason: null };
  return { ok: true, status: "beyond", distanceKm: rounded, fee: cfg.beyondFeeAmount, minOrderAmount, standardFee, reason: null };
};

// Validate + normalize a settings payload, throwing an HTTP 400 on bad values.
const badRequest = (msg) => {
  const e = new Error(msg);
  e.status = 400;
  return e;
};

const normalizeSettingsPayload = (raw) => {
  const out = {};
  const s = raw && typeof raw.settings === "object" ? raw.settings : raw && typeof raw === "object" ? raw : {};
  const boolKeys = ["delivery.enabled", "shop.onlineEnabled", "shop.forceOpen", "shop.forceClosed"];
  const timeKeys = ["shop.openTime", "shop.closeTime"];
  const textKeys = ["mail.inviteSubject", "mail.inviteBody"];
  const numKeys = [
    "shop.lat",
    "shop.lng",
    "delivery.freeRadiusKm",
    "delivery.maxRadiusKm",
    "delivery.feeAmount",
    "delivery.beyondFeeAmount",
    "delivery.minOrderAmount",
  ];
  for (const key of [...numKeys, ...boolKeys, ...timeKeys, ...textKeys]) {
    if (!(key in s)) continue;
    const v = String(s[key]).trim();
    if (textKeys.includes(key)) {
      if (v.length > 5000) throw badRequest(`${key} is too long (max 5000 characters)`);
      out[key] = v;
      continue;
    }
    if (boolKeys.includes(key)) {
      if (!["true", "false"].includes(v)) throw badRequest(`${key} must be true or false`);
      out[key] = v;
      continue;
    }
    if (timeKeys.includes(key)) {
      if (!HHMM_RE.test(v)) throw badRequest(`${key} must be a time like 10:00`);
      out[key] = v;
      continue;
    }
    const n = nOr(v, NaN);
    if (!Number.isFinite(n)) throw badRequest(`${key} must be a number`);
    if ((key === "shop.lat" && (n < -90 || n > 90)) || (key === "shop.lng" && (n < -180 || n > 180)))
      throw badRequest(`${key} is out of range`);
    if ((key === "delivery.freeRadiusKm" || key === "delivery.maxRadiusKm") && n <= 0)
      throw badRequest(`${key} must be greater than 0`);
    if (key === "delivery.feeAmount" && n < 0) throw badRequest("delivery.feeAmount cannot be negative");
    if (key === "delivery.beyondFeeAmount" && n < 0) throw badRequest("delivery.beyondFeeAmount cannot be negative");
    if (key === "delivery.minOrderAmount" && n < 0) throw badRequest("delivery.minOrderAmount cannot be negative");
    out[key] = v;
  }
  if ("delivery.freeRadiusKm" in out && "delivery.maxRadiusKm" in out && nOr(out["delivery.maxRadiusKm"]) < nOr(out["delivery.freeRadiusKm"])) {
    throw badRequest("maxRadiusKm must be greater than or equal to freeRadiusKm");
  }
  return out;
};

// ------------------------------------------------------------------- Auth
const ADMIN_ROLES = new Set(["admin", "orders", "kitchen", "cashier", "driver"]);
const ORDER_ROLES = new Set(["admin", "orders"]);
const CASHIER_STATUSES = new Set(["preparing", "ReadyToCollect", "out_for_delivery", "delivered"]);
const DRIVER_STATUSES = new Set(["out_for_delivery", "delivered"]);
const KITCHEN_STATUSES = new Set(["preparing", "ReadyToCollect", "out_for_delivery", "delivered"]);
const ALLOWED_STATUSES = ["placed", "preparing", "ReadyToCollect", "out_for_delivery", "delivered", "cancelled"];

const COOKIE_NAME = "beluchis_admin";
const SESSION_TTL_MS = 12 * 60 * 60 * 1000;
const sessions = new Map(); // token -> { principal, role, name, expiresAt }

const readCookie = (req, name) => {
  const header = req.headers.cookie || "";
  for (const part of header.split(";")) {
    const [k, ...rest] = part.trim().split("=");
    if (k === name) return decodeURIComponent(rest.join("="));
  }
  return null;
};

const getSession = (req) => {
  const token = readCookie(req, COOKIE_NAME);
  if (!token) return null;
  const s = sessions.get(token);
  if (!s) return null;
  if (Date.now() > s.expiresAt) {
    sessions.delete(token);
    return null;
  }
  return s;
};

const clearSessionCookie = (res) => {
  res.setHeader("Set-Cookie", `${COOKIE_NAME}=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0`);
};

const createSession = (res, session) => {
  const token = crypto.randomBytes(32).toString("hex");
  sessions.set(token, { ...session, expiresAt: Date.now() + SESSION_TTL_MS });
  res.setHeader(
    "Set-Cookie",
    `${COOKIE_NAME}=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${Math.floor(SESSION_TTL_MS / 1000)}`
  );
  return token;
};

// ---- Customer portal sessions (separate cookie so staff/customer don't clash)
const CUSTOMER_COOKIE = "beluchis_customer";
const customerSessions = new Map(); // token -> { customerId, expiresAt }

const getCustomerSession = (req) => {
  const token = readCookie(req, CUSTOMER_COOKIE);
  if (!token) return null;
  const s = customerSessions.get(token);
  if (!s) return null;
  if (Date.now() > s.expiresAt) {
    customerSessions.delete(token);
    return null;
  }
  return s;
};

const clearCustomerCookie = (res) => {
  res.setHeader("Set-Cookie", `${CUSTOMER_COOKIE}=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0`);
};

const createCustomerSession = (res, customerId) => {
  const token = crypto.randomBytes(32).toString("hex");
  customerSessions.set(token, { customerId, expiresAt: Date.now() + SESSION_TTL_MS });
  res.setHeader(
    "Set-Cookie",
    `${CUSTOMER_COOKIE}=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${Math.floor(SESSION_TTL_MS / 1000)}`
  );
  return token;
};

const requireCustomerSession = (req, res, next) => {
  const s = getCustomerSession(req);
  if (!s) return res.status(401).json({ error: "customer login required" });
  req.customerSession = s;
  next();
};

const currentCustomer = async (req) => {
  const s = getCustomerSession(req);
  if (!s) return null;
  return prisma.customer.findUnique({ where: { id: s.customerId } });
};

const requireAuth = (req, res, next) => {
  const s = getSession(req);
  if (!s) return res.status(401).json({ error: "authentication required" });
  req.session = s;
  next();
};

const requireRole = (...roles) => (req, res, next) => {
  const s = getSession(req);
  if (!s) return res.status(401).json({ error: "authentication required" });
  if (!roles.includes(s.role)) return res.status(403).json({ error: "insufficient permissions" });
  req.session = s;
  next();
};

// Simple per-IP throttle: 10 login attempts per 15 minutes (loopback exempt
// so local development/testing never hits the wall).
const loginAttempts = new Map();
const throttledLogin = (req) => {
  const ip = req.ip || req.socket?.remoteAddress || "unknown";
  if (ip === "127.0.0.1" || ip === "::1" || ip === "::ffff:127.0.0.1") return false;
  const now = Date.now();
  const rec = loginAttempts.get(ip);
  if (!rec || now > rec.resetAt) {
    loginAttempts.set(ip, { count: 1, resetAt: now + 15 * 60 * 1000 });
    return false;
  }
  rec.count += 1;
  return rec.count > 10;
};

const safeEquals = (a, b) => {
  const ha = crypto.createHash("sha256").update(String(a)).digest();
  const hb = crypto.createHash("sha256").update(String(b)).digest();
  return crypto.timingSafeEqual(ha, hb);
};

const publicStaffUser = ({ pinHash, ...rest }) => rest;

app.post(
  "/api/auth/login",
  asyncHandler(async (req, res) => {
    const { username = null, pin = null } = req.body || {};
    if (pin == null || String(pin).trim() === "") return res.status(400).json({ error: "PIN is required" });
    if (throttledLogin(req)) return res.status(429).json({ error: "too many login attempts, try again later" });

    const entered = String(pin);
    const uname = String(username || "").trim();

    if (!uname || uname.toLowerCase() === "admin") {
      if (!safeEquals(entered, ADMIN_PIN)) return res.status(401).json({ error: "Invalid PIN" });
      createSession(res, { principal: "env-admin", role: "admin", name: "Admin (env PIN)" });
      return res.json({ ok: true, role: "admin", name: "Admin (env PIN)" });
    }

    const user = await prisma.staffUser.findUnique({ where: { username: uname } });
    if (!user || !user.isActive) return res.status(401).json({ error: "Invalid username or PIN" });
    const ok = await bcrypt.compare(entered, user.pinHash);
    if (!ok) return res.status(401).json({ error: "Invalid username or PIN" });

    await prisma.staffUser.update({ where: { id: user.id }, data: { lastLoginAt: new Date() } });
    createSession(res, { principal: `staff:${user.id}`, role: user.role, name: user.name });
    res.json({ ok: true, role: user.role, name: user.name });
  })
);

app.post("/api/auth/logout", (req, res) => {
  const token = readCookie(req, COOKIE_NAME);
  if (token) sessions.delete(token);
  clearSessionCookie(res);
  res.json({ ok: true });
});

app.get("/api/auth/me", (req, res) => {
  const s = getSession(req);
  if (!s) return res.status(401).json({ error: "not logged in" });
  res.json({ principal: s.principal, role: s.role, name: s.name });
});

// ------------------------------------------------ Customer portal auth
const TIER_BANDS = [
  { name: "platinum", minScore: 30 },
  { name: "gold", minScore: 20 },
  { name: "silver", minScore: 10 },
  { name: "bronze", minScore: 5 },
];
const tierFor = (scorePct) => TIER_BANDS.find((b) => scorePct >= b.minScore)?.name || "none";

app.post(
  "/api/customer/auth/set-password",
  asyncHandler(async (req, res) => {
    const { cellphone = null, firstName = null, password = null } = req.body || {};
    if (!cellphone?.trim()) return res.status(400).json({ error: "cellphone is required" });
    if (!password || String(password).length < 4)
      return res.status(400).json({ error: "password must be at least 4 characters" });
    if (throttledLogin(req)) return res.status(429).json({ error: "too many attempts, try again later" });

    const phone = canonicalPhone(cellphone);
    let customer = await prisma.customer.findUnique({ where: { cellphone: phone } });
    if (!customer)
      return res.status(404).json({
        error: "No account found for that cellphone. Place an order with it first, then come back to set your password.",
      });

    const nameProvided = String(firstName || "").trim();
    if (nameProvided && !customer.username.startsWith("guest-") && customer.firstName.toLowerCase() !== nameProvided.toLowerCase()) {
      return res.status(401).json({ error: "That name does not match this account" });
    }
    if (customer.claimedAt) return res.status(400).json({ error: "This account already has a password - log in instead" });

    customer = await prisma.customer.update({
      where: { id: customer.id },
      data: {
        passwordHash: await bcrypt.hash(String(password), 10),
        claimedAt: new Date(),
        ...(customer.username.startsWith("guest-") && nameProvided ? { firstName: nameProvided } : {}),
      },
    });

    createCustomerSession(res, customer.id);
    res.status(201).json({ ok: true, customer: publicCustomer(customer) });
  })
);

app.post(
  "/api/customer/auth/register",
  asyncHandler(async (req, res) => {
    const { firstName, lastName, cellphone, email, password } = req.body || {};
    if (!String(firstName || "").trim()) return res.status(400).json({ error: "First name is required." });
    if (!String(lastName || "").trim()) return res.status(400).json({ error: "Last name is required." });
    if (!String(cellphone || "").trim()) return res.status(400).json({ error: "Cellphone is required." });
    if (!password || String(password).length < 4) return res.status(400).json({ error: "Password must be at least 4 characters." });
    const phone = canonicalPhone(cellphone);
    const existing = await prisma.customer.findUnique({ where: { cellphone: phone } });
    if (existing) return res.status(400).json({ error: "An account with that cellphone already exists. Log in or reset your password." });
    const username = "cust-" + phone.replace(/[^0-9]/g, "").slice(-8) + "-" + Math.random().toString(36).slice(2, 6);
    const customer = await prisma.customer.create({
      data: {
        firstName: String(firstName).trim(),
        lastName: String(lastName).trim(),
        email: email ? String(email).trim() || null : null,
        cellphone: phone,
        username,
        passwordHash: await bcrypt.hash(String(password), 10),
        claimedAt: new Date(),
      },
    });
    createCustomerSession(res, customer.id);
    res.status(201).json({ ok: true, customer: publicCustomer(customer) });
  })
);

app.post(
  "/api/customer/auth/reset-password",
  asyncHandler(async (req, res) => {
    const { cellphone, firstName, password } = req.body || {};
    if (!String(cellphone || "").trim()) return res.status(400).json({ error: "Cellphone is required." });
    if (!password || String(password).length < 4) return res.status(400).json({ error: "Password must be at least 4 characters." });
    const phone = canonicalPhone(cellphone);
    const customer = await prisma.customer.findUnique({ where: { cellphone: phone } });
    if (!customer || !customer.claimedAt) return res.status(404).json({ error: "No account found for that cellphone." });
    if (firstName && String(firstName).trim() && customer.firstName.toLowerCase() !== String(firstName).trim().toLowerCase())
      return res.status(401).json({ error: "That name does not match this account." });
    const updated = await prisma.customer.update({
      where: { id: customer.id },
      data: { passwordHash: await bcrypt.hash(String(password), 10) },
    });
    createCustomerSession(res, updated.id);
    res.json({ ok: true, customer: publicCustomer(updated) });
  })
);

app.post(
  "/api/customer/auth/login",
  asyncHandler(async (req, res) => {
    const { cellphone = null, password = null } = req.body || {};
    if (!cellphone?.trim() || !password)
      return res.status(400).json({ error: "cellphone and password are required" });
    if (throttledLogin(req)) return res.status(429).json({ error: "too many attempts, try again later" });

    const customer = await prisma.customer.findUnique({ where: { cellphone: canonicalPhone(cellphone) } });
    if (!customer || !customer.claimedAt) return res.status(401).json({ error: "invalid cellphone or password" });
    const ok = await bcrypt.compare(String(password), customer.passwordHash);
    if (!ok) return res.status(401).json({ error: "invalid cellphone or password" });

    createCustomerSession(res, customer.id);
    res.json({ ok: true, customer: publicCustomer(customer) });
  })
);

app.post("/api/customer/auth/logout", (req, res) => {
  const token = readCookie(req, CUSTOMER_COOKIE);
  if (token) customerSessions.delete(token);
  clearCustomerCookie(res);
  res.json({ ok: true });
});

app.get(
  "/api/customer/auth/me",
  asyncHandler(async (req, res) => {
    const customer = await currentCustomer(req);
    if (!customer) return res.status(401).json({ error: "not logged in" });
    res.json(publicCustomer(customer));
  })
);

// Active-order check: before placing an order, the storefront asks whether
// the customer already has an open order so they can confirm they really want
// a second one. Works for both logged-in customers (by session) and guests
// (by cellphone).
const ACTIVE_ORDER_STATUSES = ["placed", "preparing", "out_for_delivery"];
app.get(
  "/api/customer/active-orders",
  asyncHandler(async (req, res) => {
    // Logged-in customer: identify by session.
    const sessCustomer = await currentCustomer(req);
    if (sessCustomer) {
      const rows = await prisma.order.findMany({
        where: {
          customerId: sessCustomer.id,
          status: { in: ACTIVE_ORDER_STATUSES },
        },
        orderBy: { createdAt: "desc" },
        take: 5,
        select: { id: true, status: true, total: true, createdAt: true },
      });
      return res.json({
        hasActive: rows.length > 0,
        count: rows.length,
        orders: rows.map((o) => ({ id: o.id, status: o.status, total: Number(o.total), createdAt: o.createdAt })),
      });
    }
    // Guest: identify by cellphone query param.
    const phone = canonicalPhone(req.query.phone || "");
    if (!phone) return res.json({ hasActive: false, count: 0, orders: [] });
    const customer = await prisma.customer.findUnique({ where: { cellphone: phone } });
    if (!customer) return res.json({ hasActive: false, count: 0, orders: [] });
    const rows = await prisma.order.findMany({
      where: {
        customerId: customer.id,
        status: { in: ACTIVE_ORDER_STATUSES },
      },
      orderBy: { createdAt: "desc" },
      take: 5,
      select: { id: true, status: true, total: true, createdAt: true },
    });
    res.json({
      hasActive: rows.length > 0,
      count: rows.length,
      orders: rows.map((o) => ({ id: o.id, status: o.status, total: Number(o.total), createdAt: o.createdAt })),
    });
  })
);

// Logged-in customers can keep their own contact and delivery details current.
// The storefront pre-fills checkout from this profile.
app.put(
  "/api/customer/profile",
  requireCustomerSession,
  asyncHandler(async (req, res) => {
    const customerId = req.customerSession.customerId;
    const existing = await prisma.customer.findUnique({ where: { id: customerId } });
    if (!existing) return res.status(401).json({ error: "not logged in" });

    const { firstName, lastName, email, cellphone, addressLabel, lat, lng } = req.body || {};
    const first = firstName !== undefined ? String(firstName ?? "").trim() : undefined;
    const last = lastName !== undefined ? String(lastName ?? "").trim() : undefined;
    const finalEmail = email !== undefined ? (email == null ? null : String(email).trim() || null) : existing.email;
    const finalCell = cellphone !== undefined ? (canonicalPhone(cellphone) || null) : existing.cellphone;

    if (first !== undefined && !first) return res.status(400).json({ error: "First name is required." });
    if (last !== undefined && !last) return res.status(400).json({ error: "Last name is required." });
    if (!finalCell)
      return res.status(400).json({ error: "A cellphone number is required to log in." });
    if (!validContact(finalEmail, finalCell))
      return res.status(400).json({ error: "Please keep at least an email address or cellphone on your account." });

    const latN = lat === undefined ? undefined : lat === null || lat === "" ? null : Number.isFinite(Number(lat)) ? Number(lat) : null;
    const lngN = lng === undefined ? undefined : lng === null || lng === "" ? null : Number.isFinite(Number(lng)) ? Number(lng) : null;

    const data = {
      ...(first !== undefined ? { firstName: first } : {}),
      ...(last !== undefined ? { lastName: last } : {}),
      ...(email !== undefined ? { email: finalEmail } : {}),
      ...(cellphone !== undefined ? { cellphone: finalCell } : {}),
      ...(addressLabel !== undefined ? { addressLabel: String(addressLabel || "").trim() || null } : {}),
      ...(latN !== undefined ? { lat: latN } : {}),
      ...(lngN !== undefined ? { lng: lngN } : {}),
    };

    try {
      const row = await prisma.customer.update({ where: { id: customerId }, data });
      res.json(publicCustomer(row));
    } catch (e) {
      if (isUniqueViolation(e))
        return res.status(400).json({ error: "That cellphone or email is already used by another account." });
      throw e;
    }
  })
);

// ------------------------------------------------------------ Customer addresses (multiple delivery locations)
const ADDRESS_LIMIT = 3;
const normalizeAddressLabel = (raw) => String(raw == null ? "" : raw).trim().replace(/\s+/g, " ");
const addressLabelKey = (raw) => normalizeAddressLabel(raw).toLowerCase();
const findAddressByLabel = async (tx, customerId, label, excludeId = null) => {
  const rows = await tx.customerAddress.findMany({
    where: { customerId },
    select: { id: true, label: true },
  });
  const key = addressLabelKey(label);
  return rows.find((r) => r.id !== excludeId && addressLabelKey(r.label) === key) || null;
};
const normalizeAddressKey = (raw) =>
  String(raw == null ? "" : raw)
    .toLowerCase()
    .replace(/[.,]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
const findAddressByAddress = async (tx, customerId, address, excludeId = null) => {
  const rows = await tx.customerAddress.findMany({
    where: { customerId },
    select: { id: true, label: true, address: true },
  });
  const key = normalizeAddressKey(address);
  return rows.find((r) => r.id !== excludeId && normalizeAddressKey(r.address) === key) || null;
};

app.get(
  "/api/customer/addresses",
  requireCustomerSession,
  asyncHandler(async (req, res) => {
    const rows = await prisma.customerAddress.findMany({
      where: { customerId: req.customerSession.customerId },
      orderBy: [{ isDefault: "desc" }, { createdAt: "asc" }],
    });
    res.json({ items: rows, limit: ADDRESS_LIMIT, used: rows.length });
  })
);

app.post(
  "/api/customer/addresses",
  requireCustomerSession,
  asyncHandler(async (req, res) => {
    const customerId = req.customerSession.customerId;
    const { label, address, lat, lng, isDefault } = req.body || {};
    const normLabel = normalizeAddressLabel(label);
    const normAddress = String(address || "").trim();
    if (!normLabel) return res.status(400).json({ error: "Give this location a name (e.g. Home, Work).", code: "label_required" });
    if (normLabel.length > 30) return res.status(400).json({ error: "Location name is too long (max 30 characters).", code: "label_too_long" });
    if (!normAddress) return res.status(400).json({ error: "Address is required.", code: "address_required" });
    const latN = lat == null || lat === "" ? null : (Number.isFinite(Number(lat)) ? Number(lat) : null);
    const lngN = lng == null || lng === "" ? null : (Number.isFinite(Number(lng)) ? Number(lng) : null);
    if (latN == null || lngN == null)
      return res.status(400).json({ error: "Drop a pin on the map so we can calculate your delivery fee.", code: "pin_required" });
    const makeDefault = Boolean(isDefault);

    const row = await prisma.$transaction(async (tx) => {
      const count = await tx.customerAddress.count({ where: { customerId } });
      if (count >= ADDRESS_LIMIT)
        throw badRequest("You can save up to 3 locations. Delete one first.");
      const dup = await findAddressByLabel(tx, customerId, normLabel);
      if (dup) throw badRequest("You already have a location named " + JSON.stringify(dup.label) + ". Choose a different name.");
      const dupAddress = await findAddressByAddress(tx, customerId, normAddress);
      if (dupAddress)
        throw badRequest("That address is already saved as " + JSON.stringify(dupAddress.label) + ". Edit that location instead of adding a duplicate.");
      const first = count === 0;
      const setDefault = first ? true : makeDefault;
      if (setDefault) await tx.customerAddress.updateMany({ where: { customerId }, data: { isDefault: false } });
      return tx.customerAddress.create({
        data: {
          customerId,
          label: normLabel,
          address: normAddress,
          lat: latN,
          lng: lngN,
          isDefault: setDefault,
        },
      });
    }).catch((e) => { throw e; });
    res.status(201).json(row);
  })
);

app.put(
  "/api/customer/addresses/:id",
  requireCustomerSession,
  asyncHandler(async (req, res) => {
    const customerId = req.customerSession.customerId;
    const id = Number(req.params.id);
    const existing = await prisma.customerAddress.findUnique({ where: { id } });
    if (!existing || existing.customerId !== customerId) return res.status(404).json({ error: "not found" });

    const { label, address, lat, lng, isDefault } = req.body || {};
    const normLabel = label !== undefined ? normalizeAddressLabel(label) : existing.label;
    const normAddress = address !== undefined ? String(address || "").trim() : existing.address;
    if (!normLabel) return res.status(400).json({ error: "Give this location a name (e.g. Home, Work).", code: "label_required" });
    if (normLabel.length > 30) return res.status(400).json({ error: "Location name is too long (max 30 characters).", code: "label_too_long" });
    if (!normAddress) return res.status(400).json({ error: "Address is required.", code: "address_required" });

    const latProvided = lat !== undefined;
    const lngProvided = lng !== undefined;
    const nextLat = latProvided ? (lat === null || lat === "" ? null : (Number.isFinite(Number(lat)) ? Number(lat) : null)) : existing.lat;
    const nextLng = lngProvided ? (lng === null || lng === "" ? null : (Number.isFinite(Number(lng)) ? Number(lng) : null)) : existing.lng;
    if (nextLat == null || nextLng == null)
      return res.status(400).json({ error: "Drop a pin on the map so we can calculate your delivery fee.", code: "pin_required" });

    const makeDefault = isDefault === undefined ? undefined : Boolean(isDefault);

    const row = await prisma.$transaction(async (tx) => {
      if (label !== undefined) {
        const dup = await findAddressByLabel(tx, customerId, normLabel, id);
        if (dup) throw badRequest("You already have a location named " + JSON.stringify(dup.label) + ". Choose a different name.");
      }
      if (address !== undefined) {
        const dupAddress = await findAddressByAddress(tx, customerId, normAddress, id);
        if (dupAddress)
          throw badRequest("That address is already saved as " + JSON.stringify(dupAddress.label) + ". Edit that location instead of adding a duplicate.");
      }

      // Unsetting the only default keeps it default so one stays default.
      let effectiveDefault = makeDefault;
      if (makeDefault === false && existing.isDefault) {
        const others = await tx.customerAddress.count({ where: { customerId, id: { not: id } } });
        effectiveDefault = others === 0 ? true : false;
      }

      if (effectiveDefault === true) {
        await tx.customerAddress.updateMany({ where: { customerId, id: { not: id } }, data: { isDefault: false } });
      }
      const updated = await tx.customerAddress.update({
        where: { id },
        data: {
          label: normLabel,
          address: normAddress,
          lat: nextLat,
          lng: nextLng,
          ...(effectiveDefault !== undefined ? { isDefault: effectiveDefault } : {}),
        },
      });
      return updated;
    });
    res.json(row);
  })
);

app.delete(
  "/api/customer/addresses/:id",
  requireCustomerSession,
  asyncHandler(async (req, res) => {
    const customerId = req.customerSession.customerId;
    const id = Number(req.params.id);
    const existing = await prisma.customerAddress.findUnique({ where: { id } });
    if (!existing || existing.customerId !== customerId) return res.status(404).json({ error: "not found" });
    await prisma.$transaction(async (tx) => {
      await tx.customerAddress.delete({ where: { id } });
      // Promote the oldest remaining row to default if the default was deleted.
      const def = await tx.customerAddress.findFirst({ where: { customerId, isDefault: true } });
      if (!def) {
        const oldest = await tx.customerAddress.findFirst({ where: { customerId }, orderBy: { createdAt: "asc" } });
        if (oldest) await tx.customerAddress.update({ where: { id: oldest.id }, data: { isDefault: true } });
      }
    });
    res.json({ ok: true });
  })
);

// ------------------------------------------------------------ Staff users
app.get(
  "/api/users",
  requireAuth,
  requireRole("admin"),
  asyncHandler(async (_req, res) => {
    const rows = await prisma.staffUser.findMany({ orderBy: [{ role: "asc" }, { name: "asc" }] });
    res.json(rows.map(publicStaffUser));
  })
);

app.post(
  "/api/users",
  requireAuth,
  requireRole("admin"),
  asyncHandler(async (req, res) => {
    const { name, username, pin, role = "orders", isActive = true } = req.body || {};
    if (!name?.trim()) return res.status(400).json({ error: "name is required" });
    if (!username?.trim()) return res.status(400).json({ error: "username is required" });
    if (!pin || String(pin).trim().length < 4) return res.status(400).json({ error: "PIN must be at least 4 characters" });
    if (!ADMIN_ROLES.has(role)) return res.status(400).json({ error: `role must be one of ${[...ADMIN_ROLES].join(", ")}` });
    try {
      const row = await prisma.staffUser.create({
        data: {
          name: String(name).trim(),
          username: String(username).trim().toLowerCase(),
          pinHash: await bcrypt.hash(String(pin), 10),
          role,
          isActive,
        },
      });
      res.status(201).json(publicStaffUser(row));
    } catch (e) {
      if (isUniqueViolation(e)) return res.status(400).json({ error: "username already exists" });
      throw e;
    }
  })
);

app.put(
  "/api/users/:id",
  requireAuth,
  requireRole("admin"),
  asyncHandler(async (req, res) => {
    const id = Number(req.params.id);
    const { name, username, role, isActive } = req.body || {};
    const existing = await prisma.staffUser.findUnique({ where: { id } });
    if (!existing) return res.status(404).json({ error: "user not found" });
    if (role !== undefined && !ADMIN_ROLES.has(role))
      return res.status(400).json({ error: `role must be one of ${[...ADMIN_ROLES].join(", ")}` });
    try {
      const row = await prisma.staffUser.update({
        where: { id },
        data: {
          ...(name !== undefined ? { name: String(name).trim() } : {}),
          ...(username !== undefined ? { username: String(username).trim().toLowerCase() } : {}),
          ...(role !== undefined ? { role } : {}),
          ...(isActive !== undefined ? { isActive } : {}),
        },
      });
      res.json(publicStaffUser(row));
    } catch (e) {
      if (isUniqueViolation(e)) return res.status(400).json({ error: "username already exists" });
      throw e;
    }
  })
);

app.delete(
  "/api/users/:id",
  requireAuth,
  requireRole("admin"),
  asyncHandler(async (req, res) => {
    await prisma.staffUser.delete({ where: { id: Number(req.params.id) } });
    res.json({ ok: true });
  })
);

app.post(
  "/api/users/:id/pin",
  requireAuth,
  requireRole("admin"),
  asyncHandler(async (req, res) => {
    const id = Number(req.params.id);
    const { pin } = req.body || {};
    if (!pin || String(pin).trim().length < 4) return res.status(400).json({ error: "PIN must be at least 4 characters" });
    const existing = await prisma.staffUser.findUnique({ where: { id } });
    if (!existing) return res.status(404).json({ error: "user not found" });
    const row = await prisma.staffUser.update({
      where: { id },
      data: { pinHash: await bcrypt.hash(String(pin), 10) },
    });
    res.json(publicStaffUser(row));
  })
);

// --------------------------------------------------------------- Contact
app.post(
  "/api/contact",
  asyncHandler(async (req, res) => {
    const { name, email = null, cellphone = null, message } = req.body || {};
    if (!name?.trim()) return res.status(400).json({ error: "name is required" });
    if (!message?.trim()) return res.status(400).json({ error: "message is required" });
    if (!String(email || "").trim() && !String(cellphone || "").trim())
      return res.status(400).json({ error: "email or phone number is required" });
    const row = await prisma.contactMessage.create({
      data: {
        name: String(name).trim(),
        email: String(email || "").trim() || null,
        cellphone: String(cellphone || "").trim() || null,
        message: String(message).trim(),
      },
    });
    res.status(201).json(row);
  })
);

app.get(
  "/api/contact",
  requireAuth,
  requireRole("admin", "orders"),
  asyncHandler(async (_req, res) => {
    const rows = await prisma.contactMessage.findMany({ orderBy: [{ createdAt: "desc" }] });
    res.json(rows);
  })
);

app.put(
  "/api/contact/:id",
  requireAuth,
  requireRole("admin", "orders"),
  asyncHandler(async (req, res) => {
    const id = Number(req.params.id);
    const { isRead } = req.body || {};
    const existing = await prisma.contactMessage.findUnique({ where: { id } });
    if (!existing) return res.status(404).json({ error: "message not found" });
    const row = await prisma.contactMessage.update({
      where: { id },
      data: { ...(typeof isRead === "boolean" ? { isRead } : {}) },
    });
    res.json(row);
  })
);

app.delete(
  "/api/contact/:id",
  requireAuth,
  requireRole("admin"),
  asyncHandler(async (req, res) => {
    await prisma.contactMessage.delete({ where: { id: Number(req.params.id) } });
    res.json({ ok: true });
  })
);

// ----------------------------------------------------------------- Specials
const specialIncludes = {
  category: true,
  items: {
    include: {
      item: { include: { sizes: true } },
    },
  },
};

// Bundle rows can pin the size of a pizza (e.g. "2× Large Margherita").
// Sizes are optional so existing specials remain valid, but a supplied size
// must be one the item actually sells.
const normalizeSpecialSize = (value) => {
  const label = value == null ? "" : String(value).trim();
  return label || null;
};

const validateSpecialItems = async (items) => {
  const rows = Array.isArray(items) ? items : [];
  const ids = [...new Set(rows.map((i) => Number(i.itemId)))];
  if (!ids.length) return;
  const found = await prisma.item.findMany({
    where: { id: { in: ids } },
    select: { id: true, name: true, sizes: { select: { sizeLabel: true } } },
  });
  if (found.length !== ids.length) {
    const missing = ids.filter((id) => !found.some((f) => f.id === id));
    throw badRequest(`item(s) not found: ${missing.join(", ")}`);
  }
  const byId = new Map(found.map((item) => [item.id, item]));
  for (const row of rows) {
    const sizeLabel = normalizeSpecialSize(row.sizeLabel);
    if (!sizeLabel) continue;
    const item = byId.get(Number(row.itemId));
    if (item && !item.sizes.some((size) => size.sizeLabel === sizeLabel))
      throw badRequest(`size "${sizeLabel}" not found for item ${item.name}`);
  }
};

// "flat"  - a fixed bundle of named items at a fixed price.
// "bogo"  - the customer picks `count` items from a category and pays for the
//           higher half of the base prices.
// "deal"  - the customer picks `count` items from a category at a flat deal
//           price (e.g. any 2 Large Traditional pizzas for R200). Applied
//           automatically in the cart, see POST /api/orders.
const PICK_KINDS = new Set(["bogo", "deal"]);
const normalizeSpecialKind = (v) => {
  const k = String(v || "flat").toLowerCase();
  return PICK_KINDS.has(k) ? k : "flat";
};

// Shared guard for the pick-your-own specials: they need a category and a
// count of 2 or more. BOGO additionally requires an even count (you pay for
// half); a deal requires a price.
const validatePickKind = async (kind, categoryId, sizeLabel, count, price) => {
  const cat = await prisma.category.findUnique({ where: { id: Number(categoryId) } });
  if (!cat) throw badRequest("categoryId does not match a category");
  const n = Number(count);
  if (!Number.isInteger(n) || n < 2) throw badRequest("count must be a whole number of 2 or more");
  if (kind === "bogo" && n % 2 !== 0) throw badRequest("count must be an even number of 2 or more");

  const label = sizeLabel?.trim() || null;
  if (label) {
    // S/M/L are not the only labels on this menu - ONE, JNR ROLLA and
    // BIG BOY ROLLA exist too - so accept whatever the category sells.
    const sizes = await prisma.itemSize.findMany({
      where: { item: { categoryId: cat.id } },
      select: { sizeLabel: true },
      distinct: ["sizeLabel"],
    });
    if (!sizes.some((s) => s.sizeLabel === label))
      throw badRequest(`"${label}" is not a size sold in ${cat.name}`);
  }

  if (kind === "deal") {
    const p = Number(price);
    if (!Number.isInteger(p) || p <= 0) throw badRequest("a deal needs a price above R0");
    return { categoryId: cat.id, sizeLabel: label, count: n, price: p };
  }
  return { categoryId: cat.id, sizeLabel: label, count: n };
};

app.get(
  "/api/specials",
  asyncHandler(async (_req, res) => {
    const rows = await prisma.special.findMany({
      orderBy: [{ sortOrder: "asc" }, { name: "asc" }],
      include: specialIncludes,
    });
    res.json(rows);
  })
);

app.post(
  "/api/specials",
  requireRole("admin"),
  asyncHandler(async (req, res) => {
    const {
      name,
      description = null,
      price,
      kind = "flat",
      categoryId = null,
      sizeLabel = null,
      count = 2,
      imageUrl = null,
      showOnHome = false,
      isActive = true,
      sortOrder = 0,
      items = [],
    } = req.body || {};
    if (!name?.trim()) return res.status(400).json({ error: "name is required" });
    const kindNorm = normalizeSpecialKind(kind);

    let pick = null;
    if (PICK_KINDS.has(kindNorm)) {
      try {
        pick = await validatePickKind(kindNorm, categoryId, sizeLabel, count, price);
      } catch (e) {
        return res.status(e.status || 400).json({ error: e.message });
      }
    } else {
      if (price == null || Number(price) < 0) return res.status(400).json({ error: "price is required" });
      if (!Array.isArray(items) || items.length === 0) return res.status(400).json({ error: "at least one item is required" });
    }

    if (kindNorm === "flat") {
      try {
        await validateSpecialItems(items);
      } catch (e) {
        return res.status(e.status || 400).json({ error: e.message });
      }
    }

    const row = await prisma.special.create({
      data: {
        name: name.trim(),
        description,
        price: kindNorm === "bogo" ? 0 : Number(price ?? 0),
        kind: kindNorm,
        categoryId: pick ? pick.categoryId : null,
        sizeLabel: pick ? pick.sizeLabel : null,
        count: pick ? pick.count : 2,
        imageUrl: imageUrl?.trim() || null,
        showOnHome: Boolean(showOnHome),
        isActive,
        sortOrder: Number(sortOrder) || 0,
        items:
          kindNorm === "flat"
            ? {
                create: items.map((i) => ({
                  itemId: Number(i.itemId),
                  sizeLabel: normalizeSpecialSize(i.sizeLabel),
                  quantity: Math.max(1, Number(i.quantity) || 1),
                  extras: i.extras ? JSON.stringify(i.extras) : null,
                })),
              }
            : undefined,
      },
    });

    const full = await prisma.special.findUnique({ where: { id: row.id }, include: specialIncludes });
    res.status(201).json(full);
  })
);

app.put(
  "/api/specials/:id",
  requireRole("admin"),
  asyncHandler(async (req, res) => {
    const id = Number(req.params.id);
    const { name, description, price, kind, categoryId, sizeLabel, count, imageUrl, showOnHome, isActive, sortOrder, items } = req.body || {};
    const existing = await prisma.special.findUnique({ where: { id } });
    if (!existing) return res.status(404).json({ error: "special not found" });

    const kindNorm = kind !== undefined ? normalizeSpecialKind(kind) : existing.kind;

    let pick = null;
    if (PICK_KINDS.has(kindNorm)) {
      try {
        pick = await validatePickKind(
          kindNorm,
          categoryId !== undefined ? categoryId : existing.categoryId,
          sizeLabel !== undefined ? sizeLabel : existing.sizeLabel,
          count !== undefined ? count : existing.count,
          price !== undefined ? price : existing.price
        );
      } catch (e) {
        return res.status(e.status || 400).json({ error: e.message });
      }
    } else if (Array.isArray(items)) {
      if (items.length === 0) return res.status(400).json({ error: "at least one item is required" });
      try {
        await validateSpecialItems(items);
      } catch (e) {
        return res.status(e.status || 400).json({ error: e.message });
      }
    }

    const row = await prisma.$transaction(async (tx) => {
      const special = await tx.special.update({
        where: { id },
        data: {
          ...(name !== undefined ? { name: String(name).trim() } : {}),
          ...(description !== undefined ? { description } : {}),
          ...(price !== undefined ? { price: kindNorm === "bogo" ? 0 : Number(price) } : {}),
          ...(kind !== undefined ? { kind: kindNorm } : {}),
          ...(pick ? { categoryId: pick.categoryId, sizeLabel: pick.sizeLabel, count: pick.count } : {}),
          ...(imageUrl !== undefined ? { imageUrl: imageUrl?.trim() || null } : {}),
          ...(showOnHome !== undefined ? { showOnHome: Boolean(showOnHome) } : {}),
          ...(isActive !== undefined ? { isActive } : {}),
          ...(sortOrder !== undefined ? { sortOrder: Number(sortOrder) } : {}),
        },
      });
      if (PICK_KINDS.has(kindNorm)) {
        // Pick-your-own specials carry no fixed bundle rows.
        await tx.specialItem.deleteMany({ where: { specialId: id } });
      } else if (Array.isArray(items)) {
        await tx.specialItem.deleteMany({ where: { specialId: id } });
        await tx.specialItem.createMany({
          data: items.map((i) => ({
            specialId: id,
            itemId: Number(i.itemId),
            sizeLabel: normalizeSpecialSize(i.sizeLabel),
            quantity: Math.max(1, Number(i.quantity) || 1),
            extras: i.extras ? JSON.stringify(i.extras) : null,
          })),
        });
      }
      return special;
    });

    const full = await prisma.special.findUnique({ where: { id: row.id }, include: specialIncludes });
    res.json(full);
  })
);

app.delete(
  "/api/specials/:id",
  requireRole("admin"),
  asyncHandler(async (req, res) => {
    await prisma.special.delete({ where: { id: Number(req.params.id) } });
    res.json({ ok: true });
  })
);

// -------------------------------------------------------------- Customers
app.get(
  "/api/customers",
  requireAuth,
  requireRole("admin"),
  asyncHandler(async (_req, res) => {
    const rows = await prisma.customer.findMany({
      orderBy: { createdAt: "desc" },
      include: { _count: { select: { orders: true } } },
    });
    res.json(rows.map(publicCustomer));
  })
);

app.post(
  "/api/customers",
  requireRole("admin"),
  asyncHandler(async (req, res) => {
    const { firstName, lastName, email = null, cellphone = null, username, password, lat = null, lng = null, addressLabel = null } = req.body || {};
    if (!firstName?.trim() || !lastName?.trim()) return res.status(400).json({ error: "firstName and lastName are required" });
    if (!username?.trim()) return res.status(400).json({ error: "username is required" });
    if (!password) return res.status(400).json({ error: "password is required" });
    if (!validContact(email, cellphone)) return res.status(400).json({ error: "email or cellphone is required" });

    const passwordHash = await bcrypt.hash(password, 10);
    try {
      const row = await prisma.customer.create({
        data: {
          firstName: firstName.trim(),
          lastName: lastName.trim(),
          email: email?.trim() || null,
          cellphone: cellphone?.trim() || null,
          username: username.trim(),
          passwordHash,
          lat: lat != null ? Number(lat) : null,
          lng: lng != null ? Number(lng) : null,
          addressLabel,
        },
      });
      res.status(201).json(publicCustomer(row));
    } catch (e) {
      if (isUniqueViolation(e)) return res.status(400).json({ error: "username, email, or cellphone already exists" });
      throw e;
    }
  })
);

app.get(
  "/api/customers/:id",
  requireAuth,
  requireRole("admin"),
  asyncHandler(async (req, res) => {
    const row = await prisma.customer.findUnique({
      where: { id: Number(req.params.id) },
      include: {
        orders: {
          orderBy: { createdAt: "desc" },
          include: { items: true },
        },
      },
    });
    if (!row) return res.status(404).json({ error: "customer not found" });
    res.json(publicCustomer(row));
  })
);

app.put(
  "/api/customers/:id",
  requireRole("admin"),
  asyncHandler(async (req, res) => {
    const id = Number(req.params.id);
    const { firstName, lastName, email, cellphone, username, password, lat, lng, addressLabel } = req.body || {};
    const existing = await prisma.customer.findUnique({ where: { id } });
    if (!existing) return res.status(404).json({ error: "customer not found" });

    const finalEmail = email !== undefined ? (String(email).trim() || null) : existing.email;
    const finalCell = cellphone !== undefined ? (String(cellphone).trim() || null) : existing.cellphone;
    if (!validContact(finalEmail, finalCell)) return res.status(400).json({ error: "email or cellphone is required" });

    const data = {
      ...(firstName !== undefined ? { firstName: String(firstName).trim() } : {}),
      ...(lastName !== undefined ? { lastName: String(lastName).trim() } : {}),
      ...(email !== undefined ? { email: finalEmail } : {}),
      ...(cellphone !== undefined ? { cellphone: finalCell } : {}),
      ...(username !== undefined ? { username: String(username).trim() } : {}),
      ...(password ? { passwordHash: await bcrypt.hash(password, 10) } : {}),
      ...(lat !== undefined ? { lat: lat != null ? Number(lat) : null } : {}),
      ...(lng !== undefined ? { lng: lng != null ? Number(lng) : null } : {}),
      ...(addressLabel !== undefined ? { addressLabel } : {}),
    };
    try {
      const row = await prisma.customer.update({ where: { id }, data });
      res.json(publicCustomer(row));
    } catch (e) {
      if (isUniqueViolation(e)) return res.status(400).json({ error: "username, email, or cellphone already exists" });
      throw e;
    }
  })
);

app.delete(
  "/api/customers/:id",
  requireRole("admin"),
  asyncHandler(async (req, res) => {
    await prisma.customer.delete({ where: { id: Number(req.params.id) } });
    res.json({ ok: true });
  })
);

// ------------------------------------------------------------ Delivery config
// Public config for the storefront: radius boundaries + fee in live settings.
app.get(
  "/api/delivery/config",
  asyncHandler(async (_req, res) => {
    const cfg = await getDeliveryConfig();
    res.json({
      enabled: Boolean(cfg.enabled && cfg.shop.lat != null && cfg.shop.lng != null),
      shop: { lat: cfg.shop.lat, lng: cfg.shop.lng },
      freeRadiusKm: cfg.freeRadiusKm,
      maxRadiusKm: cfg.maxRadiusKm,
      feeAmount: cfg.feeAmount,
      beyondFeeAmount: cfg.beyondFeeAmount,
      minOrderAmount: cfg.minOrderAmount,
    });
  })
);

// Public shop-hours status for the storefront/home page. Callers can also pass
// ?at=ISO to preview a given moment (used by the admin form).
app.get(
  "/api/shop/config",
  asyncHandler(async (req, res) => {
    const at = req.query?.at ? new Date(String(req.query.at)) : new Date();
    const now = Number.isNaN(at.getTime()) ? new Date() : at;
    res.json(await getShopStatus(now));
  })
);

app.get("/api/settings", requireRole("admin"), asyncHandler(async (_req, res) => {
  const rows = await prisma.setting.findMany();
  res.json({ settings: Object.fromEntries(rows.map((r) => [r.key, r.value])) });
}));

app.put("/api/settings", requireRole("admin"), asyncHandler(async (req, res) => {
  const norm = normalizeSettingsPayload(req.body);
  await prisma.$transaction(
    Object.entries(norm).map(([key, value]) =>
      prisma.setting.upsert({ where: { key }, update: { value }, create: { key, value } })
    )
  );
  const cfg = await getDeliveryConfig();
  res.json({ ok: true, settings: Object.fromEntries(
    (await prisma.setting.findMany()).map((r) => [r.key, r.value])
  ), delivery: {
    enabled: Boolean(cfg.enabled && cfg.shop.lat != null && cfg.shop.lng != null),
    freeRadiusKm: cfg.freeRadiusKm,
    maxRadiusKm: cfg.maxRadiusKm,
    feeAmount: cfg.feeAmount,
    beyondFeeAmount: cfg.beyondFeeAmount,
    minOrderAmount: cfg.minOrderAmount,
  }, shop: await getShopStatus() });
}));

// Send a claim-invite email to an arbitrary address (admin "test" button).
// Renders with the current invite subject/body settings and the public portal URL.
app.post("/api/mail/test-invite", requireRole("admin"), asyncHandler(async (req, res) => {
  if (!mailEnabled()) return res.status(503).json({ ok: false, error: "SMTP is not configured on this server" });
  const { to = null } = req.body || {};
  if (!to || !String(to).includes("@")) return res.status(400).json({ ok: false, error: "a valid email address is required" });
  if (req.body?.settings) {
    await prisma.$transaction(
      Object.entries(normalizeSettingsPayload({ settings: req.body.settings })).map(([key, value]) =>
        prisma.setting.upsert({ where: { key }, update: { value }, create: { key, value } })
      )
    );
  }
  const subject = await getSetting("mail.inviteSubject", "Your Beluchis account is ready");
  const body = await getSetting("mail.inviteBody", "Hi {firstName},\n\nYour Beluchis account is ready. Set your password to start ordering:\n{url}\n\n— The Beluchis team");
  const url = `${PUBLIC_ORIGIN}/login`;
  const res2 = await sendMail({
    to,
    subject: fill(subject, { firstName: "there", url }),
    text: fill(body, { firstName: "there", url }),
  });
  res.status(res2.ok ? 200 : 502).json(res2);
}));

// ------------------------------------------------------------------- Orders
const orderIncludes = {
  customer: true,
  items: true,
  events: { orderBy: { createdAt: "asc" } },
};

// SQLite uses deferred transactions, so two payment callbacks for the same
// order (PayGate notify + the browser return) can both read and then deadlock
// trying to upgrade to a write lock. Serialize the write transactions in this
// process; the callback paths are low-volume and idempotent.
let paymentWriteChain = Promise.resolve();
const serializePaymentWrite = (fn) => {
  const run = paymentWriteChain.then(fn, fn);
  paymentWriteChain = run.then(
    () => undefined,
    () => undefined
  );
  return run;
};

// ------------------------------------------------------- PayGate (PayWeb3)
// Step 1: open a PayWeb3 transaction. The order is only persisted after this
// succeeds, so a gateway failure cannot leave an orphan order. The initiate
// response is signed with the same checksum used for the browser redirect.
const paygateInitiate = async ({ reference, amountCents, email = "", returnUrl, notifyUrl }) => {
  if (!PAYGATE_ENABLED) {
    const err = new Error("Online payment is not configured on this server (PAYGATE_ID/PAYGATE_KEY missing)");
    err.status = 503;
    throw err;
  }
  const fields = paygateInitiateFields({
    paygateId: PAYGATE_ID,
    key: PAYGATE_KEY,
    reference,
    amountCents,
    email,
    returnUrl,
    notifyUrl,
  });
  const res = await fetch(`${PAYGATE_ENDPOINT}/payweb3/initiate.trans`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(fields).toString(),
  });
  const text = await res.text();
  const params = new URLSearchParams(text);
  const error = params.get("ERROR") || params.get("RESULT_DESC");
  const payRequestId = params.get("PAY_REQUEST_ID");
  if (!res.ok || error || !payRequestId) {
    const err = new Error(`PayGate declined the request: ${error || `HTTP ${res.status}`}`);
    err.status = 502;
    throw err;
  }
  if (
    String(params.get("PAYGATE_ID") || "") !== String(PAYGATE_ID) ||
    String(params.get("REFERENCE") || "") !== String(reference)
  ) {
    const err = new Error("PayGate returned an unexpected merchant or reference");
    err.status = 502;
    throw err;
  }
  const redirectChecksum = paygateRedirectChecksum({
    paygateId: PAYGATE_ID,
    key: PAYGATE_KEY,
    payRequestId,
    reference,
  });
  if (String(params.get("CHECKSUM") || "").toLowerCase() !== redirectChecksum) {
    const err = new Error("PayGate initiate response checksum mismatch");
    err.status = 502;
    throw err;
  }
  return { payRequestId, redirectChecksum };
};

const paygateParamsFromRequest = (req) => {
  const params = new URLSearchParams();
  for (const [k, v] of Object.entries(req.query || {})) params.set(k, String(v));
  for (const [k, v] of Object.entries(req.body || {})) params.set(k, String(v));
  return params;
};

// Apply a verified PayWeb3 result. Notify is authoritative; a browser return
// is accepted too, but never downgrades an order that is already paid.
const applyPaygateResult = async ({ params, rawBody = null, source }) => {
  const ref = params.get("REFERENCE") || "";
  const payRequestId = params.get("PAY_REQUEST_ID") || "";
  if (!ref && !payRequestId) return { ok: false, reason: "missing reference" };

  const returnedId = params.get("PAYGATE_ID");
  if (source === "notify" && String(returnedId || "") !== String(PAYGATE_ID))
    return { ok: false, reason: "merchant mismatch" };
  if (source === "return" && returnedId != null && String(returnedId) !== String(PAYGATE_ID))
    return { ok: false, reason: "merchant mismatch" };

  const order = await prisma.order.findFirst({
    where: payRequestId ? { payRequestId } : { payRef: ref },
    include: { customer: true },
  });
  if (!order) return { ok: false, reason: "unknown order" };
  if (ref && order.payRef && ref !== order.payRef) return { ok: false, reason: "reference mismatch" };
  if (order.payRequestId && payRequestId && order.payRequestId !== payRequestId)
    return { ok: false, reason: "pay request mismatch" };

  const expected =
    source === "notify"
      ? paygateNotifyChecksum(rawBody || params.toString(), PAYGATE_KEY)
      : paygateReturnChecksum({
          paygateId: PAYGATE_ID,
          key: PAYGATE_KEY,
          payRequestId: payRequestId || order.payRequestId,
          transactionStatus: params.get("TRANSACTION_STATUS") || "",
          reference: ref || order.payRef,
        });
  if (String(params.get("CHECKSUM") || "").toLowerCase() !== expected)
    return { ok: false, reason: "checksum mismatch" };

  // The notify amount is authoritative and must match what we charged.
  if (source === "notify") {
    const amount = Number(params.get("AMOUNT"));
    const expectedAmount = Math.round(Number(order.grandTotal ?? order.total) * 100);
    if (!Number.isFinite(amount) || amount !== expectedAmount) {
      return {
        ok: false,
        reason: `amount mismatch (got ${params.get("AMOUNT")}, expected ${expectedAmount})`,
      };
    }
  }

  const outcome = paygateOutcome(params.get("TRANSACTION_STATUS"));
  const result = await serializePaymentWrite(() => prisma.$transaction(async (tx) => {
    const fresh = await tx.order.findUnique({ where: { id: order.id } });
    if (!fresh) return null;

    const alreadyPaid = fresh.paymentStatus === "paid";
    const paymentStatus = alreadyPaid ? "paid" : outcome;
    let nextStatus = fresh.status;
    let queued = false;
    let latePayment = false;
    let cancelled = false;

    if (!alreadyPaid && outcome === "paid") {
      if (fresh.status === "awaiting_payment") {
        nextStatus = "placed";
        queued = true;
      } else if (fresh.status === "cancelled") {
        // A payment can arrive after the 30-minute expiry. Never drop money:
        // re-queue it and leave a staff-visible note.
        nextStatus = "placed";
        queued = true;
        latePayment = true;
      }
    } else if (!alreadyPaid && outcome === "failed" && fresh.status === "awaiting_payment") {
      nextStatus = "cancelled";
      cancelled = true;
    }

    const updated = await tx.order.update({
      where: { id: fresh.id },
      data: {
        paymentStatus,
        status: nextStatus,
        payRequestId: payRequestId || fresh.payRequestId,
        txnId: params.get("TRANSACTION_ID") || fresh.txnId,
        resultCode: params.get("RESULT_CODE") || fresh.resultCode,
        resultDesc: params.get("RESULT_DESC") || fresh.resultDesc,
      },
      include: orderIncludes,
    });

    if (queued) {
      await tx.orderStatusEvent.create({
        data: {
          orderId: fresh.id,
          status: "placed",
          note: latePayment
            ? "Payment confirmed after order was cancelled - review before preparing"
            : "Payment confirmed",
        },
      });
    } else if (cancelled) {
      await tx.orderStatusEvent.create({
        data: { orderId: fresh.id, status: "cancelled", note: "Payment failed" },
      });
    }

    return { alreadyPaid, justPaid: !alreadyPaid && outcome === "paid", queued, latePayment, updated };
  }));

  if (!result) return { ok: false, reason: "unknown order" };
  const { justPaid, updated } = result;

  // The order-received email is held until an online payment is confirmed.
  // Notify and return can both arrive; the transaction above makes this once.
  if (justPaid && updated.customer?.email && mailEnabled()) {
    const { subject, text, html } = buildOrderConfirmation(updated);
    sendMail({ to: updated.customer.email, subject, text, html }).catch(() => {});
  }

  return {
    ok: true,
    approved: updated.paymentStatus === "paid",
    pending: updated.paymentStatus === "pending",
    latePayment: result.latePayment,
    order: updated,
  };
};

// Customer-facing result page (browser lands here after the gateway redirects).
const renderPaymentResult = (res, { approved, pending = false, resultCode, resultDesc, orderId, amountCents, ref }) => {
  const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const heading = approved ? "Payment successful" : pending ? "Payment is being confirmed" : "Payment not completed";
  const color = approved ? "#1c7c3e" : pending ? "#a36a00" : "#b3351f";
  const badge = approved ? "\u2713" : pending ? "\u2026" : "\u2717";
  const desc = approved && resultDesc === "Auth Done" ? "Your payment was authorised." : esc(resultDesc || "");
  const refSuffix = ref ? ` &middot; ${esc(ref)}` : "";
  const amount = `R${(Number(amountCents || 0) / 100).toFixed(2)}`;
  const detail = approved
    ? `Order #${esc(orderId)} &middot; ${amount} paid${refSuffix}`
    : pending
      ? `Order #${esc(orderId)} &middot; ${amount} &middot; awaiting confirmation`
      : `Order #${esc(orderId)}`;
  res.type("html").send(`<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${heading} - Beluchis</title>
<style>
  body{margin:0;font-family:system-ui,ui-sans-serif,-apple-system,'Segoe UI',Roboto,sans-serif;background:#faf8f5;color:#2a2520;display:grid;place-items:center;min-height:100vh}
  .card{background:#fff;border:1px solid #e8e0d5;border-radius:14px;box-shadow:0 8px 30px rgba(42,37,32,.08);max-width:420px;width:calc(100% - 40px);padding:32px;text-align:center}
  .badge{width:56px;height:56px;border-radius:50%;background:${color};color:#fff;font-size:28px;line-height:56px;font-weight:700;margin:0 auto 14px}
  h1{font-size:20px;margin:0 0 6px}
  p.sub{color:#6d6d6d;font-size:14px;margin:0 0 4px}
  .id{font-size:13px;color:#9a8f80;margin:14px 0}
  .btn{display:inline-block;margin-top:18px;background:#b3351f;color:#fff;border-radius:8px;padding:11px 22px;text-decoration:none;font-weight:600;font-size:14px}
  .btn.ghost{background:transparent;color:#2a2520;border:1px solid #e8e0d5;margin-left:8px}
</style></head><body><div class="card">
  <div class="badge">${badge}</div>
  <h1>${heading}</h1>
  <p class="sub">${desc}</p>
  <div class="id">${detail}</div>
  <a class="btn" href="/order">Back to menu</a>
  <a class="btn ghost" href="/portal">My orders</a>
</div></body></html>`);
};


app.get(
  "/api/orders",
  requireAuth,
  requireRole("admin", "orders", "kitchen", "cashier", "driver"),
  asyncHandler(async (req, res) => {
    // Unpaid online orders are deliberately kept out of the kitchen/cashier/
    // driver queue - including ones that failed and were cancelled. Admin/orders
    // can opt in to see them for support, but the standalone kitchen poller
    // calls this endpoint without the flag.
    const canSeePending = req.session?.role === "admin" || req.session?.role === "orders";
    const includePending = canSeePending && String(req.query.includePending || "") === "1";
    const rows = await prisma.order.findMany({
      where: includePending ? {} : {
        OR: [
          { paymentMethod: { notIn: ["paygate", "payfast"] } },
          { paymentStatus: "paid" },
        ],
      },
      orderBy: { createdAt: "desc" },
      include: orderIncludes,
    });
    res.json(rows.map(publicOrder));
  })
);

app.get(
  "/api/orders/:id",
  requireAuth,
  requireRole("admin", "orders", "kitchen", "cashier", "driver"),
  asyncHandler(async (req, res) => {
    const row = await prisma.order.findUnique({
      where: { id: Number(req.params.id) },
      include: orderIncludes,
    });
    if (!row) return res.status(404).json({ error: "order not found" });
    res.json(publicOrder(row));
  })
);

app.get(
  "/api/customers/:id/orders",
  requireAuth,
  requireRole("admin", "orders", "kitchen", "cashier"),
  asyncHandler(async (req, res) => {
    const rows = await prisma.order.findMany({
      where: { customerId: Number(req.params.id) },
      orderBy: { createdAt: "desc" },
      include: orderIncludes,
    });
    res.json(rows.map(publicOrder));
  })
);

// Resolve the items a customer picked for a BOGO / fixed-price deal special.
// Every value is validated against the DB - client prices are ignored. Throws
// a 400 via badRequest() when a pick is not allowed.
const resolvePicks = async (special, picks) => {
  if (!Array.isArray(picks) || picks.length !== special.count)
    throw badRequest(`${special.name} needs exactly ${special.count} items`);

  const resolved = [];
  for (const pick of picks) {
    if (pick.itemId == null) throw badRequest(`each ${special.name} item needs an itemId`);
    const item = await prisma.item.findUnique({ where: { id: Number(pick.itemId) }, include: { sizes: true } });
    if (!item) throw badRequest(`item ${pick.itemId} not found`);
    if (!item.isActive) throw badRequest(`item ${item.id} is not active`);
    if (special.categoryId != null && item.categoryId !== special.categoryId)
      throw badRequest(`${item.name} is not part of ${special.name}`);

    let sizeLabel = pick.sizeLabel ?? null;
    let base = 0;
    if (item.sizes.length) {
      if (!sizeLabel) {
        if (item.sizes.length !== 1) throw badRequest(`sizeLabel is required for item ${item.id}`);
        sizeLabel = item.sizes[0].sizeLabel;
      }
      const size = item.sizes.find((s) => s.sizeLabel === sizeLabel);
      if (!size) throw badRequest(`size "${sizeLabel}" not found for item ${item.id}`);
      sizeLabel = size.sizeLabel;
      base = size.price;
    }
    if (special.sizeLabel && item.sizes.length && sizeLabel !== special.sizeLabel)
      throw badRequest(`${special.name} is only available in ${special.sizeLabel}`);

    const extras = Array.isArray(pick.extras)
      ? pick.extras.map((x) => ({ name: String(x.name ?? ""), price: Number(x.price) || 0 }))
      : [];
    resolved.push({ item, sizeLabel, base, extras, extrasTotal: extras.reduce((sum, x) => sum + x.price, 0) });
  }
  return resolved;
};

app.post(
  "/api/orders",
  asyncHandler(async (req, res) => {
    const {
      customerId = null,
      firstName = null,
      lastName = null,
      cellphone = null,
      email = null,
      items = [],
      deliveryLat = null,
      deliveryLng = null,
      deliveryAddress = null,
      deliveryAddressId = null,
      notes = null,
      status = "placed",
      couponCode = null,
      paymentMethod = "cod_cash",
      quote = false,
    } = req.body || {};

    // Legacy field names from the original storefront (lat/lng) are accepted
    // alongside the canonical deliveryLat/deliveryLng.
    let lat = deliveryLat != null ? deliveryLat : req.body?.lat;
    let lng = deliveryLng != null ? deliveryLng : req.body?.lng;
    let resolvedDeliveryAddress = deliveryAddress;
    let resolvedAddressLabel = null;
    const isQuote = quote === true || quote === "true" || quote === 1 || quote === "1";

    if (!Array.isArray(items) || items.length === 0) return res.status(400).json({ error: "items are required" });

    const allowedStatuses = ["placed", "preparing", "ReadyToCollect", "out_for_delivery", "delivered", "cancelled"];
    if (!allowedStatuses.includes(status)) return res.status(400).json({ error: `status must be one of ${allowedStatuses.join(", ")}` });
    if (!PAYMENT_METHODS.has(paymentMethod))
      return res.status(400).json({ error: `paymentMethod must be one of ${[...PAYMENT_METHODS].join(", ")}` });

    // Only PayGate may be used for new online orders. PayFast remains parseable
    // for historical callbacks, but is not offered or accepted at checkout.
    const activeOnline = onlinePaymentProvider();
    if ((paymentMethod === "paygate" || paymentMethod === "payfast") && paymentMethod !== activeOnline) {
      return res.status(activeOnline ? 400 : 503).json({
        error: activeOnline
          ? "Online payment is only available through PayGate."
          : "Online payment is not configured on this server. Please choose cash or card on delivery.",
      });
    }

    // "pay_at_counter" is only valid for collection orders — it means the
    // customer will pay when they pick up, so there's nothing to collect on
    // delivery. Reject it for delivery orders.
    if (paymentMethod === "pay_at_counter") {
      const deliveryById = deliveryAddressId != null;
      const deliveryByAddr = Boolean(deliveryAddress?.trim());
      const deliveryByGeo = Number.isFinite(nOr(lat)) || Number.isFinite(nOr(lng));
      if (deliveryById || deliveryByAddr || deliveryByGeo) {
        return res.status(400).json({
          error: "'Pay at counter' is only available for collection orders. Choose cash or card on delivery.",
          code: "pay_at_counter_collection_only",
        });
      }
    }

    // Storefront hours: online ordering pauses outside the owner-set window,
    // unless the owner has forced "still open". Staff orders bypass the check.
    if (!getSession(req)) {
      const shop = await getShopStatus();
      if (!shop.open) {
        return res.status(403).json({
          error: `Sorry, we're closed for online orders right now. Our hours are ${shop.openTime}-${shop.closeTime}.`,
          code: "shop_closed",
          openTime: shop.openTime,
          closeTime: shop.closeTime,
        });
      }
    }

    // Unregistered (guest) customers may only place collection orders.
    const wantsDeliveryInitial =
      deliveryAddressId != null ||
      Boolean(deliveryAddress?.trim()) ||
      Number.isFinite(nOr(lat)) ||
      Number.isFinite(nOr(lng));
    const sessCustomer = await currentCustomer(req);
    if (wantsDeliveryInitial && !sessCustomer && !customerId) {
      return res.status(400).json({
        error: "Unregistered customers can only place collection orders. Please sign in for delivery, or clear the delivery address.",
        code: "guest_collection_only",
      });
    }

    // Customer resolution: a logged-in portal customer wins (guest orders placed
    // while signed in attach to their account), otherwise explicit customerId or
    // guest checkout that lazily finds/reuses/creates a Customer by cellphone/email.
    let customer = null;
    if (sessCustomer) {
      customer = sessCustomer;
    } else if (!customerId) {
      if (isQuote) {
        // Never create a customer row for a price-only quote.
        customer = null;
      } else {
        if (!firstName?.trim() || !lastName?.trim())
          return res.status(400).json({ error: "customerId or guest firstName/lastName is required" });
        if (!validContact(email, cellphone))
          return res.status(400).json({ error: "email or cellphone is required for guest checkout" });
        const lookupPhone = canonicalPhone(cellphone);
        const lookup = lookupPhone
          ? { cellphone: lookupPhone }
          : { email: String(email).trim() };
        customer = await prisma.customer.findUnique({ where: lookup });
        if (!customer) {
          const guestUser = `guest-${String(cellphone || email).replace(/[^a-z0-9]/gi, "").slice(-10) || Math.random().toString(36).slice(2, 8)}`;
          customer = await prisma.customer.create({
            data: {
              firstName: String(firstName).trim(),
              lastName: String(lastName).trim(),
              email: email?.trim() || null,
              cellphone: lookupPhone || null,
              username: guestUser,
              passwordHash: await bcrypt.hash(Math.random().toString(36).slice(2), 10),
            },
          });
        }
      }
    } else {
      customer = await prisma.customer.findUnique({ where: { id: Number(customerId) } });
      if (!customer) return res.status(400).json({ error: "customer not found" });
    }

    // Saved-locations-only delivery: a signed-in customer may only deliver to a
    // location they have already saved. A deliveryAddressId is required and must
    // belong to the customer; free-text / unsaved pins are rejected.
    if (deliveryAddressId != null) {
      if (!customer) {
        return res.status(400).json({ error: "Unregistered customers can only place collection orders. Please sign in for delivery.", code: "guest_collection_only" });
      }
      const addrRow = await prisma.customerAddress.findFirst({
        where: { id: Number(deliveryAddressId), customerId: customer.id },
      });
      if (!addrRow) {
        return res.status(400).json({
          error: "Choose one of your saved delivery locations.",
          code: "saved_location_required",
        });
      }
      resolvedDeliveryAddress = addrRow.address;
      lat = addrRow.lat;
      lng = addrRow.lng;
      resolvedAddressLabel = addrRow.label;
    } else {
      const wantsDelivery = wantsDeliveryInitial;
      if (wantsDelivery && customer) {
        return res.status(400).json({
          error: "Choose one of your saved delivery locations.",
          code: "saved_location_required",
        });
      }
      if (wantsDelivery && !customer) {
        return res.status(400).json({
          error: "Unregistered customers can only place collection orders. Please sign in for delivery.",
          code: "guest_collection_only",
        });
      }
    }

    // Delivery pricing: free inside the free radius only when the food
    // subtotal meets the threshold; otherwise the standard-fee band applies,
    // then a "beyond" fee with no hard cutoff. No GPS captured means
    // "unverified" - the standard fee applies and the restaurant confirms the
    // address and rate with the customer.
    const delivery = await classifyDelivery({ deliveryAddress: resolvedDeliveryAddress, lat, lng });

    const wantsDelivery = wantsDeliveryInitial;

    const rows = [];
    // Regular item lines, remembered so the automatic-deal pass below can
    // price them. BOGO/flat special rows never join this list.
    const itemRows = [];
    // Automatic fixed-price deals (kind === "deal") contribute to this, and
    // are folded into the Order-level discount together with any coupon.
    let dealSaving = 0;
    const dealLabels = new Set();
    const dealApplications = [];

    for (const line of items) {
      // Bundle/special line — validated active.
      if (line.specialId != null) {
        const special = await prisma.special.findUnique({ where: { id: Number(line.specialId) } });
        if (!special) return res.status(400).json({ error: `special ${line.specialId} not found` });
        if (!special.isActive) return res.status(400).json({ error: `special ${special.id} is not active` });

        // Fixed-price deals (kind === "deal") have no line of their own.
        // They are applied server-side off the cart's regular item lines in
        // the "automatic deals" pass further down, so a hand-crafted or
        // stale specialId can never claim one twice.
        if (special.kind === "deal") {
          return res.status(400).json({
            error: `special ${special.id} is an automatic deal - send its pizzas as normal item lines`,
          });
        }

        // BOGO: the customer chooses `count` items from the special's
        // category, optionally at a pinned size. Every price comes from the
        // DB, never the client.
        if (special.kind === "bogo") {
          const resolved = await resolvePicks(special, line.pizzas);
          const quantity = Math.max(1, Number(line.quantity) || 1);
          // Discount the cheaper half of the bases; extras stay payable.
          const cheapest = resolved
            .map((r, i) => ({ i, base: r.base }))
            .sort((a, b) => a.base - b.base)
            .slice(0, special.count / 2)
            .map((o) => o.i);
          const free = new Set(cheapest);
          resolved.forEach((r, i) => {
            const pricedBase = free.has(i) ? 0 : r.base;
            rows.push({
              itemId: r.item.id,
              itemName: r.item.name,
              sizeLabel: r.sizeLabel,
              unitPrice: pricedBase,
              quantity,
              extras: r.extras.length ? JSON.stringify(r.extras) : null,
              total: (pricedBase + r.extrasTotal) * quantity,
            });
          });
          continue;
        }

        const quantity = Math.max(1, Number(line.quantity) || 1);
        rows.push({
          itemId: null,
          itemName: special.name,
          sizeLabel: null,
          unitPrice: special.price,
          quantity,
          extras: null,
          total: special.price * quantity,
        });
        continue;
      }

      // Regular menu item line.
      if (line.itemId == null) return res.status(400).json({ error: "each line needs itemId or specialId" });
      const item = await prisma.item.findUnique({
        where: { id: Number(line.itemId) },
        include: { sizes: true },
      });
      if (!item) return res.status(400).json({ error: `item ${line.itemId} not found` });
      if (!item.isActive) return res.status(400).json({ error: `item ${item.id} is not active` });

      let sizeLabel = line.sizeLabel ?? null;
      if (item.sizes.length) {
        if (!sizeLabel) {
          if (item.sizes.length !== 1) return res.status(400).json({ error: `sizeLabel is required for item ${item.id}` });
          sizeLabel = item.sizes[0].sizeLabel;
        }
        const size = item.sizes.find((s) => s.sizeLabel === sizeLabel);
        if (!size) return res.status(400).json({ error: `size "${sizeLabel}" not found for item ${item.id}` });
        sizeLabel = size.sizeLabel;
      }

      const quantity = Math.max(1, Number(line.quantity) || 1);
      const extras = Array.isArray(line.extras) ? line.extras.map((x) => ({ name: String(x.name ?? ""), price: Number(x.price) || 0 })) : [];
      const extrasTotal = extras.reduce((sum, x) => sum + x.price, 0);
      const unitPrice = item.sizes.length ? item.sizes.find((s) => s.sizeLabel === sizeLabel).price : 0;
      rows.push({
        itemId: item.id,
        itemName: item.name,
        sizeLabel,
        unitPrice,
        quantity,
        extras: extras.length ? JSON.stringify(extras) : null,
        total: (unitPrice + extrasTotal) * quantity,
      });
      // Remember the base price so the automatic-deal pass can claim units
      // off it. Extras are deliberately not part of a deal group.
      itemRows.push({ key: itemRows.length, item, sizeLabel, base: unitPrice, qty: quantity });
    }

    // ---- Automatic fixed-price deals (kind === "deal") --------------------------
    // Applied here, server-side, off the real item rows - the same rule the
    // cart previews with Shop.applyDeals(), so what the customer saw is what
    // they are charged. Any `count` items from the special's category, at the
    // special's size, go for a flat price: group the qualifying units by size,
    // take floor(n / count) groups cheapest-first, and only reward a group when
    // the deal actually beats the normal price - so two R90 Margheritas stay at
    // R180 rather than being pushed UP to R200. Extras never qualify, and the
    // units stay billed at full price on their OrderItems.
    if (itemRows.length) {
      const dealSpecials = await prisma.special.findMany({
        where: { kind: "deal", isActive: true, categoryId: { not: null } },
      });
      // A unit is one individual pizza, so a qty-3 line contributes three.
      // `claimed` stops two overlapping deals from discounting the same pizza.
      const claimed = new Set();

      for (const s of dealSpecials) {
        if (!(s.count >= 2) || !(s.price > 0)) continue;

        const units = [];
        for (const r of itemRows) {
          if (r.item.categoryId !== s.categoryId) continue;
          if (s.sizeLabel && r.sizeLabel !== s.sizeLabel) continue;
          for (let n = 0; n < r.qty; n++) {
            const key = r.key + ":" + n;
            if (claimed.has(key)) continue;
            units.push({ key, base: r.base, sizeLabel: r.sizeLabel });
          }
        }
        if (units.length < s.count) continue;

        const sorted = units.slice().sort((a, b) => a.base - b.base);
        if (s.count === 2) {
          let lo = 0, hi = sorted.length - 1;
          while (lo < hi) {
            const chunk = [sorted[lo], sorted[hi]];
            const normal = chunk.reduce((sum, u) => sum + u.base, 0);
            const saving = Math.max(0, normal - s.price);
            if (saving > 0) {
              chunk.forEach((u) => claimed.add(u.key));
              dealSaving += saving;
              dealLabels.add(s.name);
              dealApplications.push({ name: s.name, count: s.count, price: s.price, normal, saving });
              lo++; hi--;
            } else {
              lo++;
            }
          }
        } else {
          for (let i = 0; i + s.count <= sorted.length; i += s.count) {
            const chunk = sorted.slice(i, i + s.count);
            const normal = chunk.reduce((sum, u) => sum + u.base, 0);
            const saving = Math.max(0, normal - s.price);
            if (!saving) continue;
            chunk.forEach((u) => claimed.add(u.key));
            dealSaving += saving;
            dealLabels.add(s.name);
            dealApplications.push({ name: s.name, count: s.count, price: s.price, normal, saving });
          }
        }
      }
    }

    const foodSubtotal = rows.reduce((sum, r) => sum + r.total, 0);
    // Free delivery needs both: a food subtotal at least minOrderAmount and an
    // address inside the free radius. Below the threshold, the standard fee
    // applies even inside the free radius. There is no minimum-order block.
    if (delivery.status === "free" && delivery.minOrderAmount > 0 && foodSubtotal < delivery.minOrderAmount) {
      delivery.status = "fee";
      delivery.fee = delivery.standardFee;
    }
    const deliveryFee = delivery.fee;
    // "Was" price - what the order costs with no deal and no coupon. Stored as
    // Order.total and shown struck through on every surface.
    const orderTotal = foodSubtotal + deliveryFee;
    // Automatic deals come off the food first, so a coupon applies to the
    // price the customer is actually paying.
    const subtotal = foodSubtotal - dealSaving + deliveryFee;

    // Coupon: validated server-side only (never trust the client).
    let coupon = null;
    let couponDiscount = 0;
    let couponLabel = null;
    if (couponCode && String(couponCode).trim()) {
      coupon = await prisma.coupon.findUnique({ where: { code: String(couponCode).trim() } });
      if (!coupon) return res.status(400).json({ error: `Coupon "${couponCode}" not found` });
      if (!coupon.isActive) return res.status(400).json({ error: "Coupon is no longer active" });
      if (coupon.usageLimit != null && coupon.usageCount >= coupon.usageLimit)
        return res.status(400).json({ error: "Coupon has already been redeemed" });
      if (coupon.expiresAt && new Date(coupon.expiresAt) < new Date())
        return res.status(400).json({ error: "Coupon has expired" });
      if (coupon.minSpend != null && subtotal < coupon.minSpend)
        return res.status(400).json({ error: `Coupon requires a minimum order of R${coupon.minSpend}` });
      if (coupon.customerId != null) {
        if (!sessCustomer) return res.status(400).json({ error: "Coupon is linked to a specific customer - log in to use it" });
        if (coupon.customerId !== sessCustomer.id) return res.status(400).json({ error: "Coupon does not belong to this account" });
      }
      couponDiscount =
        coupon.kind === "percent"
          ? Math.round((subtotal * Math.min(100, Math.max(0, coupon.value))) / 100)
          : Math.min(coupon.value, subtotal);
      couponLabel = coupon.label || (coupon.kind === "percent" ? `${coupon.value}% off` : `R${coupon.value} off`);
    }

    // Fold the automatic deal saving and the coupon into a single markdown -
    // that is what the receipt, cashier board, portal and confirmation email
    // already render, so no display code has to know deals exist.
    const dealLabel = [...dealLabels].join(", ") || null;
    const discountAmount = dealSaving + couponDiscount;
    const discountLabel = [dealLabel, couponLabel].filter(Boolean).join(" + ") || null;
    const grandTotal = orderTotal - discountAmount;

    // Price-only quote: validate everything, return totals, never create an
    // order, never touch coupons, never call the payment gateway.
    if (isQuote) {
      return res.status(200).json({
        quote: true,
        lines: rows.map((r) => ({
          name: r.itemName,
          sizeLabel: r.sizeLabel,
          quantity: r.quantity,
          total: r.total,
          extras: r.extras ? JSON.parse(r.extras) : [],
        })),
        foodSubtotal,
        dealSaving,
        couponDiscount,
        discountAmount,
        discountLabel,
        discounts: [
          ...dealApplications,
          ...(couponDiscount > 0 ? [{ name: couponLabel || "Coupon", count: 1, price: 0, normal: couponDiscount, saving: couponDiscount }] : []),
        ],
        deliveryFee,
        delivery: {
          status: delivery.status,
          distanceKm: delivery.distanceKm,
          fee: delivery.fee,
          minOrderAmount: delivery.minOrderAmount,
          standardFee: delivery.standardFee,
        },
        orderTotal,
        subtotal,
        grandTotal,
        deliveryAddress: resolvedDeliveryAddress,
        deliveryLat: lat != null ? Number(lat) : null,
        deliveryLng: lng != null ? Number(lng) : null,
        addressLabel: resolvedAddressLabel,
      });
    }
    // Build the gateway request BEFORE the order is persisted so a gateway
    // failure leaves no orphan order. A fully-discounted order has nothing to
    // charge: mark it paid.
    const isOnlinePayment = paymentMethod === "paygate" || paymentMethod === "payfast";
    const onlineFree = isOnlinePayment && grandTotal <= 0;
    // A paid online order only joins the kitchen queue after PayGate confirms
    // it. The row must exist before the redirect so callbacks can find it.
    const orderStatus = isOnlinePayment && !onlineFree ? "awaiting_payment" : status;
    let payRef = null;
    let payRequestId = null;
    let payRedirect = null;
    if (paymentMethod === "paygate" && !onlineFree) {
      payRef = `BELU-${crypto.randomBytes(4).toString("hex").toUpperCase()}`;
      const payEmail = String(email || customer?.email || "").trim();
      const outcome = await paygateInitiate({
        reference: payRef,
        amountCents: Math.round(grandTotal * 100),
        email: payEmail,
        returnUrl: `${PUBLIC_ORIGIN}/paygate/return`,
        notifyUrl: `${PUBLIC_ORIGIN}/paygate/notify`,
      });
      payRequestId = outcome.payRequestId;
      payRedirect = {
        url: `${PAYGATE_ENDPOINT}/payweb3/process.trans`,
        provider: "paygate",
        fields: {
          PAY_REQUEST_ID: outcome.payRequestId,
          CHECKSUM: outcome.redirectChecksum,
        },
      };
    } else if (paymentMethod === "payfast" && !onlineFree) {
      payRef = `BELU-${crypto.randomBytes(4).toString("hex").toUpperCase()}`;
      const payFirstName = String(firstName || customer?.firstName || "").trim();
      const payLastName = String(lastName || customer?.lastName || "").trim();
      const payEmail = String(email || customer?.email || "").trim();
      const fields = payfastCheckoutFields({
        merchantId: PAYFAST_ID,
        merchantKey: PAYFAST_KEY,
        passphrase: payfastPassphrase(),
        returnUrl: `${PUBLIC_ORIGIN}/payfast/return`,
        cancelUrl: `${PUBLIC_ORIGIN}/order?payment=cancelled`,
        notifyUrl: `${PUBLIC_ORIGIN}/payfast/notify`,
        reference: payRef,
        amount: grandTotal,
        firstName: payFirstName,
        lastName: payLastName,
        email: payEmail,
        itemName: `Beluchis order ${payRef}`,
        paymentMethod: PAYFAST_PAYMENT_METHOD,
      });
      payRedirect = {
        url: `${PAYFAST_ENDPOINT}/eng/process`,
        provider: "payfast",
        fields,
      };
    }

    const order = await prisma.$transaction(async (tx) => {
      const created = await tx.order.create({
        data: {
          customerId: customer.id,
          status: orderStatus,
          paymentMethod,
          paymentStatus: onlineFree ? "paid" : "pending",
          payRef,
          payRequestId,
          total: orderTotal,
          discountCode: coupon ? coupon.code : null,
          discountLabel: discountLabel || null,
          discountAmount,
          grandTotal,
          deliveryLat: lat != null ? Number(lat) : null,
          deliveryLng: lng != null ? Number(lng) : null,
          deliveryAddress: resolvedDeliveryAddress,
          deliveryDistance: delivery.distanceKm,
          deliveryFee,
          deliveryStatus: delivery.status,
          notes,
          items: { create: rows },
          events: {
            create: [orderStatus === "awaiting_payment"
              ? { status: "awaiting_payment", note: "Awaiting online payment" }
              : { status: "placed", note: "Order received" }],
          },
        },
      });
      if (coupon) {
        await tx.coupon.update({
          where: { id: coupon.id },
          data: { usageCount: { increment: 1 }, usedAt: new Date(), usedOrderId: created.id },
        });
      }
      return created;
    });

    // Delivery address is no longer mirrored onto the Customer profile; saved
    // CustomerAddress rows are the source of truth (see /api/customer/addresses).

    const full = await prisma.order.findUnique({ where: { id: order.id }, include: orderIncludes });
    const payload = publicOrder(full);
    if (payRedirect) payload.redirect = payRedirect;
    // Best-effort order confirmation email (never blocks checkout; fire & forget).
    // Online orders wait for payment confirmation so an abandoned PayGate page
    // does not email a customer an "order received" message.
    if (full.customer?.email && mailEnabled() && full.status !== "awaiting_payment") {
      const { subject, text, html } = buildOrderConfirmation(full);
      sendMail({ to: full.customer.email, subject, text, html }).catch(() => {});
    }
    res.status(201).json(payload);
  })
);

// --------------------------------------------------------- PayFast callbacks
const payfastParam = (params, key) =>
  (params?.get ? params.get(key) : params?.[key]) ?? "";

// Rebuild the posted fields in the order PayFast signed them. The global
// urlencoded parser keeps the raw body in req.rawBody, which is the only
// reliable way to preserve that order.
const payfastParamsFromRequest = (req) => {
  if (req.rawBody) return new URLSearchParams(req.rawBody);
  const qs = req.originalUrl && req.originalUrl.includes("?")
    ? req.originalUrl.slice(req.originalUrl.indexOf("?") + 1)
    : "";
  if (qs) return new URLSearchParams(qs);
  const params = new URLSearchParams();
  for (const [k, v] of Object.entries(req.body || {})) params.set(k, String(v));
  return params;
};

// PayFast's own server-to-server check. The signature already proves the
// notification came from PayFast; this catches replay/forged payloads that
// reuse a valid signature. Only a definitive "INVALID" rejects the ITN - a
// network failure must not lose a real payment.
const payfastValidateItn = async (rawBody) => {
  try {
    const res = await fetch(`${PAYFAST_ENDPOINT}/eng/query/validate`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: rawBody,
      signal: typeof AbortSignal !== "undefined" && AbortSignal.timeout ? AbortSignal.timeout(8000) : undefined,
    });
    const text = (await res.text()).trim().toUpperCase();
    if (text === "VALID") return "VALID";
    if (text === "INVALID") return "INVALID";
    console.warn(`[payfast] unexpected validation response: ${res.status} ${text.slice(0, 80)}`);
    return "UNKNOWN";
  } catch (err) {
    console.warn(`[payfast] server validation unavailable: ${err.message}`);
    return "UNKNOWN";
  }
};

// Apply a verified PayFast ITN to the matching order (matched by our reference
// in m_payment_id, stored in Order.payRef).
const applyPayfastResult = async (params, rawBody = null) => {
  if (!PAYFAST_ENABLED) return { ok: false, reason: "PayFast not configured" };
  if (!validPayfastSignature(params, payfastPassphrase())) return { ok: false, reason: "signature mismatch" };
  if (payfastParam(params, "merchant_id") !== PAYFAST_ID) return { ok: false, reason: "merchant mismatch" };

  if (rawBody) {
    const validation = await payfastValidateItn(rawBody);
    if (validation === "INVALID")
      return { ok: false, retry: true, reason: "PayFast server validation failed" };
  }

  const ref = payfastParam(params, "m_payment_id") || payfastParam(params, "custom_str1");
  if (!ref) return { ok: false, reason: "missing m_payment_id" };
  const order = await prisma.order.findFirst({ where: { payRef: ref }, include: { customer: true } });
  if (!order) return { ok: false, reason: "unknown order" };

  // PayFast sends amount_gross in Rand on the ITN; the browser return may use
  // `amount` instead. Reject a notification that does not match what we charged.
  const gross = Number(payfastParam(params, "amount_gross") || payfastParam(params, "amount"));
  const expectedAmount = order.grandTotal ?? order.total;
  if (!Number.isFinite(gross) || Math.abs(gross - expectedAmount) > 0.01) {
    return { ok: false, reason: `amount mismatch (got ${gross}, expected ${expectedAmount})` };
  }

  const status = String(payfastParam(params, "payment_status") || "").toUpperCase();
  const approved = status === "COMPLETE";
  const failed = status === "FAILED" || status === "CANCELLED";

  const result = await serializePaymentWrite(() => prisma.$transaction(async (tx) => {
    const fresh = await tx.order.findUnique({ where: { id: order.id } });
    if (!fresh) return null;
    const wasPaid = fresh.paymentStatus === "paid";
    // Never downgrade a paid order. PayFast may send duplicate or late ITNs;
    // once the money is in, only another COMPLETE may update the txn details.
    const paymentStatus = wasPaid ? "paid" : approved ? "paid" : failed ? "failed" : fresh.paymentStatus || "pending";
    const txnId = (approved || !fresh.txnId) ? (payfastParam(params, "pf_payment_id") || fresh.txnId) : fresh.txnId;
    const resultCode = wasPaid && !approved ? fresh.resultCode : status || fresh.resultCode;
    const resultDesc = wasPaid && !approved ? fresh.resultDesc : `PayFast ${status || "notification"}`;
    let nextStatus = fresh.status;
    let queued = false;
    let cancelled = false;

    if (!wasPaid && approved && (fresh.status === "awaiting_payment" || fresh.status === "cancelled")) {
      nextStatus = "placed";
      queued = true;
    } else if (!wasPaid && failed && fresh.status === "awaiting_payment") {
      nextStatus = "cancelled";
      cancelled = true;
    }

    const updated = await tx.order.update({
      where: { id: fresh.id },
      data: { paymentStatus, status: nextStatus, txnId, resultCode, resultDesc },
      include: orderIncludes,
    });
    if (queued) {
      await tx.orderStatusEvent.create({
        data: { orderId: fresh.id, status: "placed", note: "Payment confirmed" },
      });
    } else if (cancelled) {
      await tx.orderStatusEvent.create({
        data: { orderId: fresh.id, status: "cancelled", note: "Payment failed" },
      });
    }
    return { wasPaid, justPaid: !wasPaid && approved, updated };
  }));

  if (!result) return { ok: false, reason: "unknown order" };
  const { updated } = result;
  // Online order confirmations are held until payment is confirmed.
  if (result.justPaid && updated.customer?.email && mailEnabled()) {
    const { subject, text, html } = buildOrderConfirmation(updated);
    sendMail({ to: updated.customer.email, subject, text, html }).catch(() => {});
  }

  return {
    ok: true,
    approved: updated.paymentStatus === "paid",
    pending: updated.paymentStatus === "pending",
    order: updated,
  };
};

app.post(
  "/payfast/notify",
  asyncHandler(async (req, res) => {
    const params = payfastParamsFromRequest(req);
    let acknowledged = true;
    try {
      const outcome = await applyPayfastResult(params, req.rawBody || null);
      if (!outcome.ok) {
        console.warn(`[payfast] notify rejected: ${outcome.reason}`);
        // A failed PayFast server validation may be transient; let PayFast
        // retry it instead of dropping a possibly real payment.
        if (outcome.retry) acknowledged = false;
      } else
        console.log(`[payfast] notify: order #${outcome.order.id} ${outcome.approved ? "paid" : outcome.pending ? "pending" : "failed"}`);
    } catch (err) {
      // A transient database/network error should make PayFast retry. Expected
      // rejections (bad signature, unknown order, amount mismatch) return 200
      // above so PayFast does not keep retrying a notification we cannot use.
      acknowledged = false;
      console.error(`[payfast] notify failed: ${err.message}`);
    }
    // PayFast only needs a 200; anything else makes it retry the notification.
    if (acknowledged) res.type("text/plain").status(200).send("OK");
    else res.type("text/plain").status(500).send("ERROR");
  })
);

// PayFast redirects the customer's browser here after payment. The ITN may not
// have arrived yet, so show the order's stored status instead of claiming the
// payment failed. If the redirect itself carries a valid signed result, apply it.
async function payfastReturn(req, res) {
  const params = payfastParamsFromRequest(req);
  const ref = payfastParam(params, "m_payment_id") || payfastParam(params, "custom_str1");
  if (!ref) {
    return renderPaymentResult(res, {
      approved: false,
      resultDesc: "We could not match this payment to an order. If you were charged, please contact us.",
      orderId: "?",
      amountCents: 0,
    });
  }

  const existing = await prisma.order.findFirst({ where: { payRef: ref } });
  let outcome = existing
    ? { ok: true, approved: existing.paymentStatus === "paid", pending: existing.paymentStatus !== "paid" && existing.paymentStatus !== "failed", order: existing }
    : null;

  if (!existing) {
    console.warn(`[payfast] return: unknown order for ${ref}`);
  } else if (payfastParam(params, "signature") && payfastParam(params, "payment_status")) {
    const applied = await applyPayfastResult(params, req.rawBody || null);
    if (applied.ok) outcome = applied;
    else console.warn(`[payfast] return not applied: ${applied.reason}`);
  }

  if (!outcome) {
    return renderPaymentResult(res, {
      approved: false,
      resultDesc: "We could not find that order. If you were charged, please contact us.",
      orderId: ref,
      amountCents: 0,
    });
  }

  const order = outcome.order;
  renderPaymentResult(res, {
    approved: Boolean(outcome.approved),
    pending: Boolean(outcome.pending) && !outcome.approved,
    resultDesc: outcome.approved
      ? "Payment received"
      : outcome.pending
        ? "PayFast is confirming your payment. This page will show the final status once the notification arrives."
        : "Payment not completed",
    orderId: order.id,
    amountCents: (order.grandTotal ?? order.total) * 100,
    ref: payfastParam(params, "pf_payment_id") || order.txnId || null,
  });
}

app.post("/payfast/return", asyncHandler(payfastReturn));
app.get("/payfast/return", asyncHandler(payfastReturn));

app.put(
  "/api/orders/:id",
  requireAuth,
  asyncHandler(async (req, res) => {
    const id = Number(req.params.id);
    const { status } = req.body || {};
    if (!status || !ALLOWED_STATUSES.includes(status))
      return res.status(400).json({ error: `status must be one of ${ALLOWED_STATUSES.join(", ")}` });

    const role = req.session.role;
    if (role === "kitchen") {
      if (!KITCHEN_STATUSES.has(status)) return res.status(403).json({ error: "kitchen cannot set this status" });
    } else if (role === "cashier") {
      if (!CASHIER_STATUSES.has(status)) return res.status(403).json({ error: "cashier cannot set this status" });
    } else if (role === "driver") {
      if (!DRIVER_STATUSES.has(status)) return res.status(403).json({ error: "driver can only mark orders out for delivery or delivered" });
    } else if (!ORDER_ROLES.has(role)) {
      return res.status(403).json({ error: "insufficient permissions" });
    }

    const existing = await prisma.order.findUnique({ where: { id } });
    if (!existing) return res.status(404).json({ error: "order not found" });

    if (existing.status !== status) {
      await prisma.orderStatusEvent.create({
        data: { orderId: id, status, note: req.session?.name || null },
      });
    }
    await prisma.order.update({ where: { id }, data: { status } });
    const full = await prisma.order.findUnique({ where: { id }, include: orderIncludes });
    res.json(publicOrder(full));
  })
);

// ---------------------------------------------- Customer portal (order history)
const withGrandTotal = (o) => ({ ...o, grandTotal: o.grandTotal ?? o.total });

app.get(
  "/api/customer/orders",
  requireCustomerSession,
  asyncHandler(async (req, res) => {
    const rows = await prisma.order.findMany({
      where: { customerId: req.customerSession.customerId },
      orderBy: { createdAt: "desc" },
      include: { items: true, events: { orderBy: { createdAt: "asc" } } },
    });
    res.json(rows.map(withGrandTotal));
  })
);

app.get(
  "/api/customer/orders/:id",
  requireCustomerSession,
  asyncHandler(async (req, res) => {
    const row = await prisma.order.findUnique({
      where: { id: Number(req.params.id) },
      include: { items: true, events: { orderBy: { createdAt: "asc" } } },
    });
    if (!row || row.customerId !== req.customerSession.customerId)
      return res.status(404).json({ error: "order not found" });
    res.json(withGrandTotal(row));
  })
);

app.get(
  "/api/customer/offers",
  requireCustomerSession,
  asyncHandler(async (req, res) => {
    const rows = await prisma.coupon.findMany({
      where: {
        customerId: req.customerSession.customerId,
        isActive: true,
        usedAt: null,
        OR: [{ expiresAt: null }, { expiresAt: { gt: new Date() } }],
      },
      orderBy: { createdAt: "desc" },
    });
    res.json(rows);
  })
);

// ------------------------------------------------- Customer favorites (portal)
const favoriteIncludes = {
  item: { include: { sizes: true, category: true } },
  special: { include: { category: true } },
};

app.get(
  "/api/customer/favorites",
  requireCustomerSession,
  asyncHandler(async (req, res) => {
    const rows = await prisma.favorite.findMany({
      where: { customerId: req.customerSession.customerId },
      orderBy: { createdAt: "desc" },
      include: favoriteIncludes,
    });
    res.json(rows);
  })
);

// Toggle a favorite. Send exactly one of itemId / specialId; the response says
// whether it is now saved ("liked") so the heart button can render state.
app.post(
  "/api/customer/favorites",
  requireCustomerSession,
  asyncHandler(async (req, res) => {
    const customerId = req.customerSession.customerId;
    const { itemId = null, specialId = null } = req.body || {};
    if ((itemId == null) === (specialId == null))
      return res.status(400).json({ error: "send exactly one of itemId or specialId" });

    if (itemId != null) {
      const item = await prisma.item.findUnique({ where: { id: Number(itemId) }, select: { id: true } });
      if (!item) return res.status(400).json({ error: `item ${itemId} not found` });
      const existing = await prisma.favorite.findUnique({
        where: { customerId_itemId: { customerId, itemId: Number(itemId) } },
      });
      if (existing) {
        await prisma.favorite.delete({ where: { id: existing.id } });
        return res.json({ ok: true, liked: false });
      }
      const row = await prisma.favorite.create({ data: { customerId, itemId: Number(itemId) } });
      return res.json({ ok: true, liked: true, favorite: row });
    }

    const special = await prisma.special.findUnique({ where: { id: Number(specialId) }, select: { id: true } });
    if (!special) return res.status(400).json({ error: `special ${specialId} not found` });
    const existing = await prisma.favorite.findUnique({
      where: { customerId_specialId: { customerId, specialId: Number(specialId) } },
    });
    if (existing) {
      await prisma.favorite.delete({ where: { id: existing.id } });
      return res.json({ ok: true, liked: false });
    }
    const row = await prisma.favorite.create({ data: { customerId, specialId: Number(specialId) } });
    res.json({ ok: true, liked: true, favorite: row });
  })
);

app.delete(
  "/api/customer/favorites/:id",
  requireCustomerSession,
  asyncHandler(async (req, res) => {
    const row = await prisma.favorite.findUnique({ where: { id: Number(req.params.id) } });
    if (!row || row.customerId !== req.customerSession.customerId)
      return res.status(404).json({ error: "favorite not found" });
    await prisma.favorite.delete({ where: { id: row.id } });
    res.json({ ok: true });
  })
);

// ---------------------------------------------------------------- Uploads
// Pictures arrive as a JSON data URL (no multipart dependency) and are written
// under public/uploads/, which express.static already serves at /uploads/*.
const UPLOAD_DIR = path.join(__dirname, "..", "public", "uploads");
const UPLOAD_MAX_BYTES = 6 * 1024 * 1024;
const DATA_URL_RE = /^data:image\/(png|jpe?g|gif|webp);base64,([A-Za-z0-9+/=]+)$/i;
const EXT_BY_MIME = { png: "png", jpg: "jpg", jpeg: "jpg", gif: "gif", webp: "webp" };

app.post(
  "/api/upload",
  requireRole("admin"),
  asyncHandler(async (req, res) => {
    const { dataUrl } = req.body || {};
    const m = DATA_URL_RE.exec(String(dataUrl || "").trim());
    if (!m) return res.status(400).json({ error: "dataUrl must be a base64 image (png, jpg, gif or webp)" });
    const ext = EXT_BY_MIME[m[1].toLowerCase()];
    const buf = Buffer.from(m[2], "base64");
    if (!buf.length) return res.status(400).json({ error: "image is empty" });
    if (buf.length > UPLOAD_MAX_BYTES) return res.status(400).json({ error: "image must be 6MB or smaller" });
    await fsp.mkdir(UPLOAD_DIR, { recursive: true });
    const name = `${Date.now()}-${crypto.randomBytes(4).toString("hex")}.${ext}`;
    await fsp.writeFile(path.join(UPLOAD_DIR, name), buf);
    res.status(201).json({ ok: true, url: `/uploads/${name}` });
  })
);

// -------------------------------------------------------- Loyalty (admin)
app.get(
  "/api/loyalty/customers",
  requireRole("admin"),
  asyncHandler(async (req, res) => {
    const q = String(req.query.q || "").trim().toLowerCase();
    const tier = String(req.query.tier || "all").trim().toLowerCase();
    const requestedWindow = String(req.query.window || "365");
    const window = ["30", "90", "365", "lifetime"].includes(requestedWindow) ? requestedWindow : "365";
    const minSpend = req.query.minSpend != null && req.query.minSpend !== "" ? Number(req.query.minSpend) : null;
    const minOrders = req.query.minOrders != null && req.query.minOrders !== "" ? Number(req.query.minOrders) : null;

    // Revenue = payable (grandTotal ?? total) on non-cancelled orders.
    const orders = await prisma.order.findMany({
      where: { status: { not: "cancelled" } },
      select: { customerId: true, total: true, grandTotal: true, createdAt: true },
    });
    const customers = await prisma.customer.findMany({
      select: { id: true, firstName: true, lastName: true, cellphone: true, email: true },
    });

    const windows = [30, 90, 365];
    const spend = { 30: new Map(), 90: new Map(), 365: new Map(), lifetime: new Map() };
    const totals = { 30: 0, 90: 0, 365: 0, lifetime: 0 };
    const orderCount = new Map();
    const lastOrder = new Map();
    const now = Date.now();
    for (const o of orders) {
      const pay = o.grandTotal ?? o.total;
      const cid = o.customerId;
      orderCount.set(cid, (orderCount.get(cid) || 0) + 1);
      totals.lifetime += pay;
      spend.lifetime.set(cid, (spend.lifetime.get(cid) || 0) + pay);
      const age = now - new Date(o.createdAt).getTime();
      for (const d of windows) {
        if (age <= d * 864e5) {
          totals[d] += pay;
          spend[d].set(cid, (spend[d].get(cid) || 0) + pay);
        }
      }
      const prev = lastOrder.get(cid);
      if (!prev || new Date(o.createdAt) > new Date(prev)) lastOrder.set(cid, o.createdAt);
    }

    const score = (map, total) => (total > 0 ? Math.round(((map || 0) / total) * 1000) / 10 : 0);

    const rows = [];
    for (const c of customers) {
      const s30 = spend[30].get(c.id) || 0;
      const s90 = spend[90].get(c.id) || 0;
      const s365 = spend[365].get(c.id) || 0;
      const sLife = spend.lifetime.get(c.id) || 0;
      const score365 = score(s365, totals[365]);
      const t = tierFor(score365);
      if (tier !== "all" && t !== tier) continue;
      if (minSpend != null && (window === "lifetime" ? sLife : spend[Number(window)].get(c.id) || 0) < minSpend) continue;
      const count = orderCount.get(c.id) || 0;
      if (minOrders != null && count < minOrders) continue;
      if (q) {
        const hay = `${c.firstName} ${c.lastName} ${c.cellphone || ""} ${c.email || ""}`.toLowerCase();
        if (!hay.includes(q)) continue;
      }
      rows.push({
        id: c.id,
        name: `${c.firstName} ${c.lastName}`.trim(),
        firstName: c.firstName,
        lastName: c.lastName,
        cellphone: c.cellphone,
        email: c.email,
        orders: count,
        lastOrderAt: lastOrder.get(c.id) || null,
        spend30: s30,
        spend90: s90,
        spend365: s365,
        spendLifetime: sLife,
        score30: score(s30, totals[30]),
        score90: score(s90, totals[90]),
        score365,
        scoreLifetime: score(sLife, totals.lifetime),
        tier: t,
      });
    }

    const sortKey = { 30: "spend30", 90: "spend90", 365: "spend365", lifetime: "spendLifetime" }[window];
    rows.sort((a, b) => (b[sortKey] || 0) - (a[sortKey] || 0));

    res.json({ window, totals, tierBands: TIER_BANDS, total: rows.length, rows });
  })
);

app.get(
  "/api/loyalty/coupons",
  requireRole("admin"),
  asyncHandler(async (req, res) => {
    const status = String(req.query.status || "all");
    const now = new Date();
    const where =
      status === "active"
        ? { isActive: true, usedAt: null, OR: [{ expiresAt: null }, { expiresAt: { gt: now } }] }
        : status === "used"
          ? { usedAt: { not: null } }
          : status === "expired"
            ? { isActive: true, usedAt: null, expiresAt: { lte: now } }
            : {};
    const rows = await prisma.coupon.findMany({
      where,
      include: { customer: { select: { id: true, firstName: true, lastName: true, cellphone: true } } },
      orderBy: { createdAt: "desc" },
    });
    res.json(rows);
  })
);

app.post(
  "/api/loyalty/coupons",
  requireRole("admin"),
  asyncHandler(async (req, res) => {
    const {
      customerId = null,
      kind = "percent",
      value,
      label = null,
      minSpend = null,
      expiresAt = null,
      note = null,
      usageLimit = null,
    } = req.body || {};

    const kindNorm = kind === "rand" ? "rand" : "percent";
    const v = Number(value);
    if (!Number.isFinite(v) || v <= 0) return res.status(400).json({ error: "value must be a positive number" });
    if (kindNorm === "percent" && v > 100) return res.status(400).json({ error: "percent cannot exceed 100" });
    let customer = null;
    if (customerId != null) {
      customer = await prisma.customer.findUnique({ where: { id: Number(customerId) } });
      if (!customer) return res.status(400).json({ error: "customer not found" });
    }

    const row = await prisma.coupon.create({
      data: {
        code: `BELU-${crypto.randomBytes(4).toString("hex").toUpperCase()}`,
        kind: kindNorm,
        value: Math.round(v),
        label: label?.trim() || (kindNorm === "percent" ? `${Math.round(v)}% off` : `R${Math.round(v)} off`),
        minSpend: minSpend != null && minSpend !== "" ? Number(minSpend) : null,
        expiresAt: expiresAt ? new Date(expiresAt) : null,
        note: note?.trim() || null,
        customerId: customer ? customer.id : null,
        usageLimit: customer ? 1 : usageLimit != null && usageLimit !== "" ? Number(usageLimit) : null,
      },
    });
    res.status(201).json(row);
  })
);

app.put(
  "/api/loyalty/coupons/:id",
  requireRole("admin"),
  asyncHandler(async (req, res) => {
    const { isActive } = req.body || {};
    if (isActive == null) return res.status(400).json({ error: "isActive is required" });
    const row = await prisma.coupon.update({
      where: { id: Number(req.params.id) },
      data: { isActive: Boolean(isActive) },
    });
    res.json(row);
  })
);

// --------------------------------------------------------------- Categories
app.get(
  "/api/categories",
  asyncHandler(async (_req, res) => {
    const rows = await prisma.category.findMany({
      orderBy: [{ sortOrder: "asc" }, { name: "asc" }],
      include: { _count: { select: { items: true } } },
    });
    res.json(rows);
  })
);

app.post(
  "/api/categories",
  requireRole("admin"),
  asyncHandler(async (req, res) => {
    const { name, description = null, dealText = null, sortOrder = 0, isActive = true } = req.body || {};
    if (!name) return res.status(400).json({ error: "name is required" });
    const row = await prisma.category.create({
      data: { name, slug: slugify(name), description, dealText, sortOrder: Number(sortOrder) || 0, isActive },
    });
    res.status(201).json(row);
  })
);

app.put(
  "/api/categories/:id",
  requireRole("admin"),
  asyncHandler(async (req, res) => {
    const { name, description, dealText, sortOrder, isActive } = req.body || {};
    const row = await prisma.category.update({
      where: { id: Number(req.params.id) },
      data: {
        ...(name !== undefined ? { name, slug: slugify(name) } : {}),
        ...(description !== undefined ? { description } : {}),
        ...(dealText !== undefined ? { dealText } : {}),
        ...(sortOrder !== undefined ? { sortOrder: Number(sortOrder) } : {}),
        ...(isActive !== undefined ? { isActive } : {}),
      },
    });
    res.json(row);
  })
);

app.delete(
  "/api/categories/:id",
  requireRole("admin"),
  asyncHandler(async (req, res) => {
    await prisma.category.delete({ where: { id: Number(req.params.id) } });
    res.json({ ok: true });
  })
);

// --------------------------------------------------------------------- Items
const itemIncludes = {
  category: true,
  sizes: true,
  images: { orderBy: { sortOrder: "asc" } },
  toppings: { include: { topping: { include: { prices: true } } } },
  bases: { include: { base: { include: { prices: true } } } },
};

app.get(
  "/api/items",
  asyncHandler(async (_req, res) => {
    const rows = await prisma.item.findMany({
      orderBy: [{ sortOrder: "asc" }, { name: "asc" }],
      include: itemIncludes,
    });
    res.json(rows);
  })
);

app.post(
  "/api/items",
  requireRole("admin"),
  asyncHandler(async (req, res) => {
    const { name, description = null, itemType = "menuitem", categoryId = null, imageUrl = null, showOnHome = false, sizes = [], toppingIds = [], baseIds = [], images = [], sortOrder = 0 } = req.body || {};
    if (!name) return res.status(400).json({ error: "name is required" });

    const row = await prisma.$transaction(async (tx) => {
      const item = await tx.item.create({
        data: {
          name,
          slug: slugify(name),
          description,
          itemType,
          categoryId: categoryId ? Number(categoryId) : null,
          imageUrl: imageUrl?.trim() || null,
          showOnHome: Boolean(showOnHome),
          sortOrder: Number(sortOrder) || 0,
        },
      });
      if (sizes.length) {
        await tx.itemSize.createMany({
          data: sizes.map((s) => ({ itemId: item.id, sizeLabel: s.sizeLabel, price: Number(s.price) })),
        });
      }
      if (toppingIds.length) {
        await tx.itemTopping.createMany({
          data: toppingIds.map((id) => ({ itemId: item.id, toppingId: Number(id) })),
        });
      }
      if (baseIds.length) {
        await tx.itemBase.createMany({
          data: baseIds.map((id) => ({ itemId: item.id, baseId: Number(id) })),
        });
      }
      if (Array.isArray(images) && images.length) {
        await tx.itemImage.createMany({
          data: images.map((im, i) => ({ itemId: item.id, url: (im && im.url) || String(im), alt: (im && im.alt) || null, sortOrder: (im && im.sortOrder) ?? i })),
        });
      }
      return item;
    });
    const full = await prisma.item.findUnique({ where: { id: row.id }, include: itemIncludes });
    res.status(201).json(full);
  })
);

app.put(
  "/api/items/:id",
  requireRole("admin"),
  asyncHandler(async (req, res) => {
    const { name, description, itemType, categoryId, imageUrl, showOnHome, sizes, toppingIds, baseIds, images, sortOrder, isActive } = req.body || {};
    const id = Number(req.params.id);
    const row = await prisma.$transaction(async (tx) => {
      const item = await tx.item.update({
        where: { id },
        data: {
          ...(name !== undefined ? { name, slug: slugify(name) } : {}),
          ...(description !== undefined ? { description } : {}),
          ...(itemType !== undefined ? { itemType } : {}),
          ...(categoryId !== undefined ? { categoryId: categoryId ? Number(categoryId) : null } : {}),
          ...(imageUrl !== undefined ? { imageUrl: imageUrl?.trim() || null } : {}),
          ...(showOnHome !== undefined ? { showOnHome: Boolean(showOnHome) } : {}),
          ...(sortOrder !== undefined ? { sortOrder: Number(sortOrder) } : {}),
          ...(isActive !== undefined ? { isActive } : {}),
        },
      });

      if (Array.isArray(sizes)) {
        await tx.itemSize.deleteMany({ where: { itemId: id } });
        if (sizes.length) {
          await tx.itemSize.createMany({
            data: sizes.map((s) => ({ itemId: id, sizeLabel: s.sizeLabel, price: Number(s.price) })),
          });
        }
      }
      if (Array.isArray(toppingIds)) {
        await tx.itemTopping.deleteMany({ where: { itemId: id } });
        if (toppingIds.length) {
          await tx.itemTopping.createMany({
            data: toppingIds.map((tid) => ({ itemId: id, toppingId: Number(tid) })),
          });
        }
      }
      if (Array.isArray(baseIds)) {
        await tx.itemBase.deleteMany({ where: { itemId: id } });
        if (baseIds.length) {
          await tx.itemBase.createMany({
            data: baseIds.map((bid) => ({ itemId: id, baseId: Number(bid) })),
          });
        }
      }
      if (Array.isArray(images)) {
        await tx.itemImage.deleteMany({ where: { itemId: id } });
        if (images.length) {
          await tx.itemImage.createMany({
            data: images.map((im, i) => ({ itemId: id, url: (im && im.url) || String(im), alt: (im && im.alt) || null, sortOrder: (im && im.sortOrder) ?? i })),
          });
        }
      }
      return item;
    });
    const full = await prisma.item.findUnique({ where: { id: row.id }, include: itemIncludes });
    res.json(full);
  })
);

app.delete(
  "/api/items/:id",
  requireRole("admin"),
  asyncHandler(async (req, res) => {
    await prisma.item.delete({ where: { id: Number(req.params.id) } });
    res.json({ ok: true });
  })
);

// ------------------------------------------------------------------ Toppings
app.get(
  "/api/toppings",
  asyncHandler(async (_req, res) => {
    const rows = await prisma.topping.findMany({
      orderBy: [{ tier: "asc" }, { sortOrder: "asc" }, { name: "asc" }],
      include: { prices: true, _count: { select: { items: true } } },
    });
    res.json(rows);
  })
);

app.post(
  "/api/toppings",
  requireRole("admin"),
  asyncHandler(async (req, res) => {
    const { name, tier = 0, isInSeason = true, prices = [], sortOrder = 0 } = req.body || {};
    if (!name) return res.status(400).json({ error: "name is required" });
    const row = await prisma.topping.create({
      data: {
        name,
        slug: slugify(name),
        tier: Number(tier) || 0,
        isInSeason: Boolean(isInSeason),
        sortOrder: Number(sortOrder) || 0,
        prices: prices.length
          ? { create: prices.map((p) => ({ sizeLabel: p.sizeLabel, price: Number(p.price) })) }
          : undefined,
      },
      include: { prices: true },
    });
    res.status(201).json(row);
  })
);

app.put(
  "/api/toppings/:id",
  requireRole("admin"),
  asyncHandler(async (req, res) => {
    const id = Number(req.params.id);
    const { name, tier, prices, sortOrder, isActive, isInSeason } = req.body || {};
    const row = await prisma.$transaction(async (tx) => {
      const topping = await tx.topping.update({
        where: { id },
        data: {
          ...(name !== undefined ? { name, slug: slugify(name) } : {}),
          ...(tier !== undefined ? { tier: Number(tier) } : {}),
          ...(sortOrder !== undefined ? { sortOrder: Number(sortOrder) } : {}),
          ...(isActive !== undefined ? { isActive } : {}),
          ...(isInSeason !== undefined ? { isInSeason: Boolean(isInSeason) } : {}),
        },
      });
      if (Array.isArray(prices)) {
        await tx.toppingPrice.deleteMany({ where: { toppingId: id } });
        if (prices.length) {
          await tx.toppingPrice.createMany({
            data: prices.map((p) => ({ toppingId: id, sizeLabel: p.sizeLabel, price: Number(p.price) })),
          });
        }
      }
      return topping;
    });
    const full = await prisma.topping.findUnique({ where: { id }, include: { prices: true } });
    res.json(full);
  })
);

app.delete(
  "/api/toppings/:id",
  requireRole("admin"),
  asyncHandler(async (req, res) => {
    await prisma.topping.delete({ where: { id: Number(req.params.id) } });
    res.json({ ok: true });
  })
);

// ---------------------------------------------------------------------- Bases
app.get(
  "/api/bases",
  asyncHandler(async (_req, res) => {
    const rows = await prisma.base.findMany({
      orderBy: [{ sortOrder: "asc" }, { name: "asc" }],
      include: { prices: true, _count: { select: { items: true } } },
    });
    res.json(rows);
  })
);

app.post(
  "/api/bases",
  requireRole("admin"),
  asyncHandler(async (req, res) => {
    const { name, description = null, prices = [], sortOrder = 0 } = req.body || {};
    if (!name) return res.status(400).json({ error: "name is required" });
    const row = await prisma.base.create({
      data: {
        name,
        slug: slugify(name),
        description,
        sortOrder: Number(sortOrder) || 0,
        prices: prices.length
          ? { create: prices.map((p) => ({ sizeLabel: p.sizeLabel, price: Number(p.price) })) }
          : undefined,
      },
      include: { prices: true },
    });
    res.status(201).json(row);
  })
);

app.put(
  "/api/bases/:id",
  requireRole("admin"),
  asyncHandler(async (req, res) => {
    const id = Number(req.params.id);
    const { name, description, prices, sortOrder, isActive } = req.body || {};
    const row = await prisma.$transaction(async (tx) => {
      const base = await tx.base.update({
        where: { id },
        data: {
          ...(name !== undefined ? { name, slug: slugify(name) } : {}),
          ...(description !== undefined ? { description } : {}),
          ...(sortOrder !== undefined ? { sortOrder: Number(sortOrder) } : {}),
          ...(isActive !== undefined ? { isActive } : {}),
        },
      });
      if (Array.isArray(prices)) {
        await tx.basePrice.deleteMany({ where: { baseId: id } });
        if (prices.length) {
          await tx.basePrice.createMany({
            data: prices.map((p) => ({ baseId: id, sizeLabel: p.sizeLabel, price: Number(p.price) })),
          });
        }
      }
      return base;
    });
    const full = await prisma.base.findUnique({ where: { id }, include: { prices: true } });
    res.json(full);
  })
);

app.delete(
  "/api/bases/:id",
  requireRole("admin"),
  asyncHandler(async (req, res) => {
    await prisma.base.delete({ where: { id: Number(req.params.id) } });
    res.json({ ok: true });
  })
);

// --------------------------------------------------------- PayGate callbacks
app.post(
  "/paygate/notify",
  asyncHandler(async (req, res) => {
    const params = paygateParamsFromRequest(req);
    const outcome = await applyPaygateResult({
      params,
      rawBody: req.rawBody || params.toString(),
      source: "notify",
    });
    if (outcome.reason) console.warn(`[paygate] notify rejected: ${outcome.reason}`);
    // PayWeb3 requires a bare "OK" reply to acknowledge the notification.
    res.type("text/plain").send("OK");
  })
);

app.post("/paygate/return", asyncHandler(paygateReturn));
app.get("/paygate/return", asyncHandler(paygateReturn));

async function paygateReturn(req, res) {
  const params = paygateParamsFromRequest(req);
  const outcome = await applyPaygateResult({ params, source: "return" });
  if (!outcome.ok) {
    console.warn(`[paygate] return rejected: ${outcome.reason}`);
    return renderPaymentResult(res, {
      approved: false,
      resultDesc: "We could not verify this payment. Your order was not charged.",
      orderId: params.get("REFERENCE") || params.get("PAY_REQUEST_ID") || "?",
      amountCents: 0,
    });
  }
  renderPaymentResult(res, {
    approved: outcome.approved,
    pending: outcome.pending,
    resultCode: outcome.order.resultCode,
    resultDesc: outcome.order.resultDesc,
    orderId: outcome.order.id,
    amountCents: Math.round(Number(outcome.order.grandTotal ?? outcome.order.total) * 100),
    ref: outcome.order.payRef,
  });
}

// ---------------------------------------------------------------------- Stats
app.get(
  "/api/stats",
  asyncHandler(async (_req, res) => {
    const [items, toppings, bases, categories, links, customers, orders, orderItems, specials, contact, coupons, orderStatusEvents] = await Promise.all([
      prisma.item.count(),
      prisma.topping.count(),
      prisma.base.count(),
      prisma.category.count(),
      prisma.itemTopping.count(),
      prisma.customer.count(),
      prisma.order.count(),
      prisma.orderItem.count(),
      prisma.special.count(),
      prisma.contactMessage.count(),
      prisma.coupon.count(),
      prisma.orderStatusEvent.count(),
    ]);
    res.json({
      items,
      toppings,
      bases,
      categories,
      links,
      customers,
      orders,
      orderItems,
      specials,
      contact,
      coupons,
      orderStatusEvents,
    });
  })
);

const HOST = process.env.HOST || "0.0.0.0";
const UNPAID_ORDER_TIMEOUT_MS = 30 * 60 * 1000;

// Unpaid online orders are invisible to the queue and are cancelled after
// 30 minutes. A late PayGate approval still re-queues the order (see
// applyPaygateResult) so a real payment is never lost.
const expireUnpaidOrders = async () => {
  const cutoff = new Date(Date.now() - UNPAID_ORDER_TIMEOUT_MS);
  const stale = await prisma.order.findMany({
    where: {
      createdAt: { lt: cutoff },
      paymentMethod: { in: ["paygate", "payfast"] },
      paymentStatus: { not: "paid" },
      status: { in: ["awaiting_payment", "placed"] },
    },
    select: { id: true },
  });
  let changed = 0;
  for (const { id } of stale) {
    const result = await serializePaymentWrite(() => prisma.$transaction(async (tx) => {
      const fresh = await tx.order.findUnique({ where: { id } });
      if (!fresh || !["awaiting_payment", "placed"].includes(fresh.status)) return null;
      if (fresh.paymentStatus === "paid") {
        if (fresh.status === "awaiting_payment") {
          await tx.order.update({ where: { id }, data: { status: "placed" } });
          await tx.orderStatusEvent.create({ data: { orderId: id, status: "placed", note: "Payment confirmed" } });
        }
        return "placed";
      }
      await tx.order.update({
        where: { id },
        data: {
          status: "cancelled",
          paymentStatus: "failed",
          resultDesc: fresh.resultDesc || "Payment not received within 30 minutes.",
        },
      });
      await tx.orderStatusEvent.create({
        data: { orderId: id, status: "cancelled", note: "Payment not received within 30 minutes" },
      });
      return "cancelled";
    }));
    if (result) changed += 1;
  }
  if (changed) console.log(`[paygate] expired ${changed} unpaid order(s)`);
  return changed;
};

const publicOriginIsHttps = /^https:\/\//i.test(PUBLIC_ORIGIN) && !/localhost|127\.0\.0\.1/i.test(PUBLIC_ORIGIN);
app.listen(PORT, HOST, () => {
  console.log(`Beluchis menu admin running at http://${HOST}:${PORT}`);
  if (PAYGATE_ENABLED) {
    console.log(`[paygate] enabled (${PAYGATE_ENDPOINT})`);
    if (!publicOriginIsHttps) {
      console.warn("[paygate] PUBLIC_BASE_URL is not a public HTTPS origin; PayGate return/notify callbacks will not work.");
    }
  } else {
    console.log("[paygate] disabled (PAYGATE_ID / PAYGATE_KEY not set)");
  }
  if (PAYFAST_ENABLED) {
    console.log(`[payfast] legacy fallback enabled (${PAYFAST_ENDPOINT})`);
    if (!PAYFAST_PASSPHRASE) {
      console.warn("[payfast] PAYFAST_PASSPHRASE is empty; if the PayFast dashboard has a salt passphrase, signatures will be rejected.");
    }
    if (!publicOriginIsHttps) {
      console.warn("[payfast] PUBLIC_BASE_URL is not a public HTTPS origin; PayFast return/notify callbacks will not work.");
    }
  } else {
    console.log("[payfast] disabled (PAYFAST_ID / PAYFAST_KEY not set)");
  }
  expireUnpaidOrders().catch((err) => console.error(`[paygate] expiry sweep failed: ${err.message}`));
  const expiryTimer = setInterval(() => {
    expireUnpaidOrders().catch((err) => console.error(`[paygate] expiry sweep failed: ${err.message}`));
  }, 60_000);
  expiryTimer.unref?.();
});
