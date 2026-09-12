import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const delay = (ms) => new Promise((r) => setTimeout(r, ms));
const args = process.argv.slice(2);
const CHROME = args[0] || "/usr/bin/google-chrome";
const BASE = "http://localhost:3100";
const port = 9222 + Math.floor(Math.random() * 1000);
const profile = mkdtempSync(join(tmpdir(), "chrdp-"));

const chrome = spawn(
  CHROME,
  [
    "--headless=new",
    "--no-sandbox",
    "--disable-gpu",
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${profile}`,
    "about:blank",
  ],
  { stdio: "ignore" }
);

const base = `http://127.0.0.1:${port}`;
let ws;

async function getPageWs() {
  for (let i = 0; i < 40; i++) {
    try {
      const list = await (await fetch(`${base}/json`)).json();
      const page = list.find((t) => t.type === "page");
      if (page) return page.webSocketDebuggerUrl;
    } catch {}
    await delay(250);
  }
  throw new Error("chrome devtools not reachable");
}

let seq = 0;
let pending = new Map();
function send(method, params = {}) {
  const id = ++seq;
  ws.send(JSON.stringify({ id, method, params }));
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    setTimeout(() => {
      if (pending.has(id)) {
        pending.delete(id);
        reject(new Error(`timeout: ${method}`));
      }
    }, 15000);
  });
}
async function evalJs(expr) {
  const r = await send("Runtime.evaluate", { expression: expr, awaitPromise: true, returnByValue: true });
  if (r.exceptionDetails) throw new Error("eval error: " + JSON.stringify(r.exceptionDetails.exception?.description || r.exceptionDetails.text));
  return r.result?.value;
}

let failures = 0;
function check(name, ok) {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}`);
  if (!ok) failures++;
}

try {
  ws = new WebSocket(await getPageWs());
  await new Promise((res, rej) => {
    ws.onopen = res;
    ws.onerror = rej;
    ws.onmessage = (e) => {
      const m = JSON.parse(e.data);
      if (m.id && pending.has(m.id)) {
        const { resolve, reject } = pending.get(m.id);
        pending.delete(m.id);
        if (m.error) reject(new Error(m.error.message));
        else resolve(m.result);
      }
    };
  });

  await send("Page.enable");
  await send("Runtime.enable");
  await send("Page.navigate", { url: BASE });
  await delay(1500);

  // page has loaded data
  const stats = await evalJs(`document.querySelector("#stats").textContent`);
  check("stats bar populated", /items/.test(stats));

  const itemRows = await evalJs(`document.querySelectorAll("#tab-items tbody tr").length`);
  check(`items table renders rows (got ${itemRows})`, itemRows > 50);

  const firstItem = await evalJs(`document.querySelector("#tab-items tbody tr td").textContent`);
  check(`first item row has content`, firstItem.length > 0);

  // switch to Toppings tab
  await evalJs(`document.querySelector('[data-tab="toppings"]').click()`);
  await delay(300);
  const toppingVisible = await evalJs(`!document.querySelector("#tab-toppings").hidden`);
  const toppingRows = await evalJs(`document.querySelectorAll("#tab-toppings tbody tr").length`);
  check(`toppings tab visible with rows (${toppingRows})`, toppingVisible && toppingRows === 40);

  // add a topping via the UI
  await evalJs(`openTopping()`);
  await delay(200);
  await evalJs(`(() => {
    document.querySelector("#t-name").value = "SMOKE TOPPING";
    document.querySelector("#t-tier").value = 9;
    const inputs = document.querySelectorAll("#t-prices input[placeholder='price']");
    inputs[0].value = 11;
    const ev = new Event("input", { bubbles: true });
    inputs[0].dispatchEvent(ev);
  })()`);
  await evalJs(`saveTopping()`);
  await delay(800);

  const found = await evalJs(`[...document.querySelectorAll("#tab-toppings tbody tr")].some(tr => tr.textContent.includes("SMOKE TOPPING"))`);
  check("UI added SMOKE TOPPING", found);

  const smokeId = await evalJs(`fetch("/api/toppings").then(r=>r.json()).then(a=>a.find(t=>t.name==="SMOKE TOPPING").id)`);
  check("smoke topping persisted via API", Number.isInteger(smokeId));

  // edit it
  await evalJs(`openTopping(${smokeId})`);
  await delay(200);
  await evalJs(`document.querySelector("#t-name").value = "SMOKE TOPPING EDITED"`);
  await evalJs(`saveTopping(${smokeId})`);
  await delay(800);
  const renamed = await evalJs(`fetch("/api/toppings").then(r=>r.json()).then(a=>a.some(t=>t.name==="SMOKE TOPPING EDITED"))`);
  check("UI renamed topping", renamed);

  // delete it
  await evalJs(`window.confirm = () => true`);
  await evalJs(`delTopping(${smokeId})`);
  await delay(800);
  const gone = await evalJs(`fetch("/api/toppings").then(r=>r.json()).then(a=>!a.some(t=>t.id===${smokeId}))`);
  check("UI deleted topping", gone);

  // item edit modal opens
  await evalJs(`document.querySelector('[data-tab="items"]').click()`);
  await delay(300);
  const itemId = await evalJs(`fetch("/api/items").then(r=>r.json()).then(a=>a[0].id)`);
  await evalJs(`openItem(${itemId})`);
  await delay(200);
  const hasModal = await evalJs(`!!document.querySelector(".overlay .modal")`);
  check("item edit modal opens", hasModal);
  await evalJs(`document.querySelector(".overlay button.ghost").click()`);

  // categories tab renders
  await evalJs(`document.querySelector('[data-tab="categories"]').click()`);
  await delay(300);
  const catRows = await evalJs(`document.querySelectorAll("#tab-categories tbody tr").length`);
  check(`categories tab rows (${catRows})`, catRows === 14);
} catch (e) {
  console.error("ERROR:", e.message);
  failures++;
} finally {
  try { ws?.close(); } catch {}
  chrome.kill("SIGKILL");
  await delay(300);
}

console.log(failures === 0 ? "\nALL UI TESTS PASSED" : `\n${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);