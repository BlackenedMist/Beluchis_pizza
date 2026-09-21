// Storefront (menu.html + shared shop.js) smoke test over CDP.
// Usage: node scripts/storefront-smoke.mjs [chromePath]
import { spawn } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PrismaClient } from "@prisma/client";
import bcrypt from "bcryptjs";

const prisma = new PrismaClient();
const TEST_PHONE = "+27000000099";
async function seedTestCustomer() {
  const passwordHash = await bcrypt.hash("smoke1234", 10);
  return prisma.customer.upsert({
    where: { cellphone: TEST_PHONE },
    update: { passwordHash, claimedAt: new Date() },
    create: {
      firstName: "Smoke", lastName: "Guest", username: "smoke-home-check",
      cellphone: TEST_PHONE, passwordHash, claimedAt: new Date(),
    },
  });
}

const delay = (ms) => new Promise((r) => setTimeout(r, ms));
const CHROME = process.argv[2] || "/usr/bin/google-chrome";
const PORT = process.env.PORT || "3100";
const BASE = `http://localhost:${PORT}`;
const port = 9222 + Math.floor(Math.random() * 1000);
const profile = mkdtempSync(join(tmpdir(), "chrdp-"));

const chrome = spawn(
  CHROME,
  ["--headless=new", "--no-sandbox", "--disable-gpu", `--remote-debugging-port=${port}`, `--user-data-dir=${profile}`, "about:blank"],
  { stdio: "ignore" }
);

let seq = 0;
const pending = new Map();
const pageErrors = [];
let ws;
function send(method, params = {}) {
  const id = ++seq;
  ws.send(JSON.stringify({ id, method, params }));
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    setTimeout(() => { if (pending.has(id)) { pending.delete(id); reject(new Error("timeout: " + method)); } }, 15000);
  });
}
async function evalJs(expression) {
  const r = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
  if (r.exceptionDetails) throw new Error("eval error: " + (r.exceptionDetails.exception?.description || r.exceptionDetails.text));
  return r.result?.value;
}

let failures = 0;
const check = (name, ok) => { console.log(`${ok ? "PASS" : "FAIL"}  ${name}`); if (!ok) failures++; };

let bogoId = null;
let homePlainId = null;
let cookie = "";

async function api(path, opts = {}) {
  const res = await fetch(BASE + path, {
    ...opts,
    headers: { "Content-Type": "application/json", ...(cookie ? { cookie } : {}), ...(opts.headers || {}) },
  });
  const setC = res.headers.getSetCookie?.() || [];
  if (setC.length) cookie = setC.map((c) => c.split(";")[0]).join("; ");
  return { status: res.status, body: await res.json().catch(() => null) };
}

try {
  for (let i = 0; i < 40; i++) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${port}/json`)).json();
      const page = list.find((t) => t.type === "page");
      if (page) { ws = new WebSocket(page.webSocketDebuggerUrl); break; }
    } catch {}
    await delay(250);
  }
  if (!ws) throw new Error("chrome devtools not reachable");
  await new Promise((res, rej) => {
    ws.onopen = res; ws.onerror = rej;
    ws.onmessage = (e) => {
      const m = JSON.parse(e.data);
      if (m.id && pending.has(m.id)) {
        const { resolve, reject } = pending.get(m.id);
        pending.delete(m.id);
        if (m.error) reject(new Error(m.error.message)); else resolve(m.result);
      } else if (m.method === "Runtime.exceptionThrown") {
        pageErrors.push(m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text);
      }
    };
  });
  await send("Page.enable");
  await send("Runtime.enable");

  // ---- seed a BOGO special through the admin API ------------------------
  const cats = await api("/api/categories");
  const pizzaCat = cats.body.find((c) => /pizza/i.test(c.name)) || cats.body[0];
  const login = await api("/api/auth/login", { method: "POST", body: JSON.stringify({ username: "", pin: process.env.ADMIN_PIN || "1234" }) });
  check("admin login", login.status === 200);
  const made = await api("/api/specials", {
    method: "POST",
    body: JSON.stringify({ name: "SMOKE BOGO", description: "smoke test deal", kind: "bogo", categoryId: pizzaCat.id, count: 2, showOnHome: true }),
  });
  check("bogo special created", made.status === 201 && made.body.kind === "bogo");
  bogoId = made.body.id;

  // ---- load the storefront ---------------------------------------------
  const shop = await api("/api/shop/config");
  const testCustomer = await seedTestCustomer();
  check("test customer seeded", Number.isInteger(testCustomer.id));
  const allItems = (await api("/api/items")).body || [];
  const plain = allItems.find((i) => i.isActive !== false && !(i.bases || []).length && !(i.toppings || []).length && (i.sizes || []).length);
  homePlainId = plain ? plain.id : null;
  if (homePlainId) await api("/api/items/" + homePlainId, { method: "PUT", body: JSON.stringify({ showOnHome: true }) });
  check(`plain item flagged for home (${plain ? plain.name : "none"})`, Boolean(homePlainId));
  await send("Page.navigate", { url: BASE + "/order" });
  await delay(2200);

  const nav = await evalJs(`!!window.Shop && typeof Shop.load === "function"`);
  check("shared shop.js loaded", nav);
  const sections = await evalJs(`document.querySelectorAll("#app section.category").length`);
  check(`menu rendered categories (${sections})`, sections > 5);
  const bogoCard = await evalJs(`[...document.querySelectorAll(".special-card")].find(c => c.textContent.includes("SMOKE BOGO"))?.querySelector("[data-bogo-id]") ? true : false`);
  check("bogo special renders a Build-your-deal button", bogoCard);

  // ---- quick add a plain item (no base/topping options -> no dialog) ----
  const quick = await evalJs(`(() => {
    const el = [...document.querySelectorAll(".item")].find(i => i.querySelector(".stepper") && i.querySelector("button[data-size]"));
    if (!el) return "none";
    el.querySelector("button[data-size]").click();
    return "ok";
  })()`);
  check("found a quick-add item", quick === "ok");
  await delay(250);
  const badge = await evalJs(`document.querySelector("#cart-badge").textContent`);
  check(`quick add increments cart badge (${badge})`, badge === "1");
  const lineCount = await evalJs(`document.querySelectorAll("#cart-lines .cart-line").length`);
  check(`cart drawer renders the line (${lineCount})`, lineCount === 1);

  // ---- closed shop blocks checkout -------------------------------------
  if (!shop.body.open) {
    const banner = await evalJs(`document.body.textContent.includes("closed right now")`);
    check("closed banner shown on menu", banner);
    await evalJs(`document.querySelector('[data-action="open-cart"]').click()`);
    await delay(150);
    const toast = await evalJs(`(() => { document.querySelector('[data-action="checkout"]').click(); return document.querySelector("#toast").textContent; })()`);
    check(`checkout blocked while closed (toast: ${toast})`, /closed/i.test(toast || ""));
  } else {
    console.log("SKIP  closed-shop checks (shop is open right now)");
  }

  // ---- build a BOGO deal ------------------------------------------------
  await evalJs(`document.querySelector('[data-bogo-id="${bogoId}"]').click()`);
  await delay(250);
  const rows = await evalJs(`document.querySelectorAll("#bogo-modal select[data-bogo-item]").length`);
  check(`bogo modal renders 2 pickers (${rows})`, rows === 2);
  const total0 = await evalJs(`document.querySelector("#bogo-total").textContent`);
  check(`bogo total shown (${total0})`, /^R\d/.test(total0 || ""));
  await evalJs(`document.querySelector('[data-action="confirm-bogo"]').click()`);
  await delay(250);
  const badge2 = await evalJs(`document.querySelector("#cart-badge").textContent`);
  check(`bogo added to cart (badge ${badge2})`, badge2 === "2");
  const bogoLine = await evalJs(`[...document.querySelectorAll("#cart-lines .cart-line")].some(l => l.textContent.includes("SMOKE BOGO"))`);
  check("bogo line rendered in drawer", bogoLine);

  // ---- deleting the special drops it from the cart on next load ---------
  await api("/api/specials/" + bogoId, { method: "DELETE" });
  bogoId = null;
  await send("Page.navigate", { url: BASE + "/order" });
  await delay(2000);
  const stillThere = await evalJs(`window.Shop.lines().some(l => l.name === "SMOKE BOGO")`);
  check("stale bogo line reconciled away after reload", stillThere === false);

  // ---- seasonal swap (avocado out of season) ---------------------------
  const toppings = await api("/api/toppings");
  const avo = toppings.body.find((t) => /avocado/i.test(t.name));
  check("avocado topping exists", Boolean(avo));
  if (avo) {
    await api("/api/toppings/" + avo.id, { method: "PUT", body: JSON.stringify({ ...avo, isInSeason: false }) });
    await send("Page.navigate", { url: BASE + "/order" });
    await delay(2000);
    const report = await evalJs(`(async () => {
      for (const el of [...document.querySelectorAll(".item")]) {
        const btn = el.querySelector("button[data-size]");
        if (!btn || el.querySelector(".stepper")) continue;
        btn.click();
        await new Promise((r) => setTimeout(r, 120));
        const sel = document.querySelector("#pick-swap");
        if (sel) return {
          found: true,
          options: [...sel.options].map((o) => o.textContent),
          outOfSeason: [...document.querySelectorAll("#customize-modal input[disabled]")].map((i) => i.parentElement.textContent.trim()),
        };
        document.querySelector('[data-action="close-customize"]')?.click();
      }
      return { found: false };
    })()`);
    check("swap picker offered for an item with out-of-season avocado", report.found);
    check(`out-of-season topping disabled (${(report.outOfSeason || []).join("; ")})`, (report.outOfSeason || []).some((t) => /out of season/i.test(t)));
    check(`swap options list "Remove ..." (${(report.options || []).slice(0, 2).join(" | ")})`, (report.options || [])[0]?.startsWith("Remove"));
    const swapped = await evalJs(`(async () => {
      const sel = document.querySelector("#pick-swap");
      if (sel.options.length > 1) { sel.selectedIndex = 1; sel.dispatchEvent(new Event("change", { bubbles: true })); }
      document.querySelector('[data-action="confirm-custom"]').click();
      await new Promise((r) => setTimeout(r, 150));
      return window.Shop.lines().map((l) => (l.extras || []).map((e) => e.name).join(",")).join(" ; ");
    })()`);
    const expectSwap = (report.options || []).length > 1;
    check(`swap recorded on the added line (${swapped})`, expectSwap ? /Swap:/.test(swapped) : /Swap:/.test(swapped) === false);
    await api("/api/toppings/" + avo.id, { method: "PUT", body: JSON.stringify({ ...avo, isInSeason: true }) });
  }

  check("no uncaught page errors", pageErrors.length === 0);
  if (pageErrors.length) console.log(pageErrors.join("\n"));

  // ===================== home page (shoppable tiles + shared cart) =======
  await send("Page.navigate", { url: BASE + "/" });
  await delay(600);
  await evalJs(`localStorage.removeItem("beluchis-cart-v1")`);
  await send("Page.navigate", { url: BASE + "/" });
  await delay(2200);

  const tileCount = await evalJs(`document.querySelectorAll("#home-tiles .tile").length`);
  check(`home tiles rendered (${tileCount})`, tileCount >= 7);
  const hours = await evalJs(`document.querySelector("#hours-line").textContent`);
  const cfg0 = await api("/api/shop/config");
  check(`home hours are dynamic (${hours})`, hours === cfg0.body.openTime + " \u2013 " + cfg0.body.closeTime);
  const flag = await evalJs(`document.querySelector("#shop-flag").textContent`);
  check(`home shop flag renders (${flag})`, /open|closed/i.test(flag || ""));
  const signedOut = await evalJs(`document.querySelector("#nav-account").textContent`);
  check(`header shows SIGN IN when logged out (${signedOut})`, signedOut === "SIGN IN");

  const addSel = await evalJs(`(() => {
    const b = document.querySelector('#home-tiles .tile button.quick[data-add-item="${homePlainId}"]')
      || document.querySelector('#home-tiles .tile button.quick[data-add-item]');
    if (!b) return "none";
    b.click();
    return "ok";
  })()`);
  check("home tile has a one-tap Add", addSel === "ok");
  await delay(250);
  const bar = await evalJs(`(() => ({
    shown: document.querySelector("#mini-cart").classList.contains("show"),
    count: document.querySelector("#mini-cart-count").textContent,
    total: document.querySelector("#mini-cart-total").textContent,
    body: document.body.classList.contains("has-cart"),
  }))()`);
  check(`mini-cart bar appears with 1 item (${bar.count} / ${bar.total})`, bar.shown && bar.count === "1" && /^R\d/.test(bar.total) && bar.body);

  await send("Page.navigate", { url: BASE + "/order" });
  await delay(2000);
  const sharedBadge = await evalJs(`document.querySelector("#cart-badge").textContent`);
  check(`home cart is the same cart as the menu (badge ${sharedBadge})`, sharedBadge === "1");

  await send("Page.navigate", { url: BASE + "/" });
  await delay(1800);
  const loggedIn = await evalJs(`fetch("/api/customer/auth/login", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ cellphone: ${JSON.stringify(TEST_PHONE)}, password: "smoke1234" }) }).then(r => r.ok)`);
  check("customer login from the browser", loggedIn === true);
  await send("Page.navigate", { url: BASE + "/" });
  await delay(1800);
  const navText = await evalJs(`document.querySelector("#nav-account").textContent`);
  const navHref = await evalJs(`document.querySelector("#nav-account").getAttribute("href")`);
  check(`header switches to MY ORDERS when signed in (${navText})`, /^MY ORDERS/.test(navText || "") && navHref === "/portal");

  const checkoutBar = await evalJs(`document.querySelector("#mini-cart").classList.contains("show")`);
  if (checkoutBar) {
    await Promise.all([
      evalJs(`document.querySelector('#mini-cart button[data-action="checkout"]').click(); true`),
      delay(900),
    ]);
    const url = await evalJs(`location.pathname + location.search`);
    check(`home checkout hands off to the menu (${url})`, url.startsWith("/order"));
  }

  // ============= customer portal: favourites + repeat order ==============
  const plainSize = (plain.sizes || []).find((s) => s.isActive !== false) || (plain.sizes || [])[0];
  const pastOrder = await prisma.order.create({
    data: {
      customerId: testCustomer.id,
      status: "delivered",
      paymentMethod: "cod_cash",
      paymentStatus: "paid",
      total: plainSize.price * 2,
      grandTotal: plainSize.price * 2,
      items: {
        create: [{ itemId: plain.id, itemName: plain.name, sizeLabel: plainSize.sizeLabel, unitPrice: plainSize.price, quantity: 2, total: plainSize.price * 2 }],
      },
      events: { create: [{ status: "placed" }, { status: "delivered" }] },
    },
  });

  await send("Page.navigate", { url: BASE + "/order" });
  await delay(600);
  await evalJs(`localStorage.removeItem("beluchis-cart-v1")`);
  await send("Page.navigate", { url: BASE + "/order" });
  await delay(2200);

  const heart = await evalJs(`(() => {
    const b = document.querySelector('button[data-fav-item="${plain.id}"]');
    if (!b) return "none";
    b.click();
    return "ok";
  })()`);
  check("menu renders a favourite heart on a dish", heart === "ok");
  await delay(700);
  const heartState = await evalJs(`(() => {
    const b = document.querySelector('button[data-fav-item="${plain.id}"]');
    return { pressed: b.getAttribute("aria-pressed"), text: b.textContent };
  })()`);
  check(`heart marks the dish as favourited (${heartState.pressed})`, heartState.pressed === "true" && heartState.text.includes("\u2665"));
  const favApi = await evalJs(`fetch("/api/customer/favorites").then((r) => r.json())`);
  check("favourite persisted server-side", Array.isArray(favApi) && favApi.some((f) => f.itemId === plain.id));

  await send("Page.navigate", { url: BASE + "/portal" });
  await delay(2200);
  const favPanel = await evalJs(`(() => {
    const panel = document.querySelector("#favorites-panel");
    return { hidden: panel.hidden, count: panel.querySelectorAll(".fav").length, text: panel.textContent };
  })()`);
  check(`portal lists the favourite (${favPanel.count})`, favPanel.hidden === false && favPanel.count === 1 && favPanel.text.includes(plain.name));
  const orderCards = await evalJs(`document.querySelectorAll(".order-card").length`);
  const reorderBtn = await evalJs(`(() => {
    const b = [...document.querySelectorAll(".reorder-btn")].find((x) => x.closest(".order-card").textContent.includes("#${pastOrder.id}"));
    if (!b) return "none";
    b.click();
    return "ok";
  })()`);
  check(`portal renders the past order with a Reorder button (${orderCards} card(s))`, reorderBtn === "ok");
  await delay(1800);
  const reorderUrl = await evalJs(`location.pathname + location.search`);
  const reordered = await evalJs(`window.Shop.lines().map((l) => l.itemId)`);
  check(`reorder rebuilds the cart and hands off to checkout (${reorderUrl})`, reorderUrl.startsWith("/order") && reordered.includes(plain.id));

  await send("Page.navigate", { url: BASE + "/portal" });
  await delay(2200);
  const removed = await evalJs(`(async () => {
    const btn = document.querySelector("#favorites .fav .ghost");
    if (!btn) return "none";
    btn.click();
    await new Promise((r) => setTimeout(r, 800));
    return document.querySelector("#favorites-panel").hidden;
  })()`);
  check("removing a favourite hides the panel", removed === true);
  const favApi2 = await evalJs(`fetch("/api/customer/favorites").then((r) => r.json())`);
  check("favourite removed server-side", Array.isArray(favApi2) && favApi2.length === 0);

  check("no uncaught page errors after portal run", pageErrors.length === 0);
} catch (e) {
  console.error("ERROR:", e.message);
  failures++;
} finally {
  if (bogoId) { try { await api("/api/specials/" + bogoId, { method: "DELETE" }); } catch {} }
  if (homePlainId) { try { await api("/api/items/" + homePlainId, { method: "PUT", body: JSON.stringify({ showOnHome: false }) }); } catch {} }
  try { await prisma.customer.deleteMany({ where: { cellphone: TEST_PHONE } }); } catch {}
  await prisma.$disconnect();
  try { ws?.close(); } catch {}
  chrome.kill("SIGKILL");
  await delay(300);
}

console.log(failures === 0 ? "\nALL STOREFRONT TESTS PASSED" : `\n${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
