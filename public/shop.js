/* Shared storefront cart + catalog helpers.
   Used by both the full menu (/order) and the home page (/home) so that
   tiles on the home page add into the exact same cart (localStorage). */
(function () {
  "use strict";

  const CART_KEY = "beluchis-cart-v1";
  const $ = (s, root) => (root || document).querySelector(s);
  const $$ = (s, root) => [...(root || document).querySelectorAll(s)];
  const money = (n) => "R" + (Number.isInteger(n) ? n : Number(n).toFixed(2));
  const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

  /* ---------------------------------------------------------------- state */
  let CART = loadCart();
  const DATA = { cats: [], items: [], specials: [], toppings: [], byId: new Map(), catById: new Map(), dupeNames: new Set(), delivery: null };

  function loadCart() {
    try {
      const v = JSON.parse(localStorage.getItem(CART_KEY) || "[]");
      return Array.isArray(v) ? v : [];
    } catch { return []; }
  }
  const saveCart = () => localStorage.setItem(CART_KEY, JSON.stringify(CART));

  const lineKey = (l) =>
    l.kind === "special"
      ? "s" + l.specialId + (l.pizzas ? "|" + l.pizzas.map((p) => p.itemId).join(".") : "")
      : "i" + l.itemId + "|" + l.sizeLabel + "|" + (l.extras || []).map((e) => e.name + ":" + e.price).join(",");

  const lines = () => CART;
  const count = () => CART.reduce((s, l) => s + l.qty, 0);
  const total = () => CART.reduce((s, l) => s + (l.unitPrice + (l.extras || []).reduce((a, e) => a + e.price, 0)) * l.qty, 0);

  function emit() {
    saveCart();
    renderCart();
    syncUI();
    if (hooks.onCartChange) hooks.onCartChange(CART);
  }

  function addLine(line) {
    const k = lineKey(line);
    const existing = CART.find((l) => lineKey(l) === k);
    if (existing) existing.qty = Math.min(99, existing.qty + line.qty);
    else CART.push({ ...line, qty: Math.max(1, line.qty || 1) });
    emit();
  }

  function changeQty(idx, delta) {
    const l = CART[idx];
    if (!l) return;
    l.qty += delta;
    if (l.qty <= 0) CART.splice(idx, 1);
    emit();
  }

  function removeLine(idx) {
    CART.splice(idx, 1);
    emit();
  }

  // The cart array is always mutated in place so that pages can safely keep a
  // reference to it (`const CART = Shop.cart`).
  function setLines(next) { CART.length = 0; CART.push(...(next || [])); emit(); }
  function clear() { CART.length = 0; emit(); }

  /* ------------------------------------------------ geometry / pricing ops */
  const sizeRowOf = (item, label) => (item.sizes || []).find((s) => s.sizeLabel === label && s.isActive !== false);
  const basePriceOf = (b, size) => (b.base.prices.find((p) => p.sizeLabel === size) || {}).price ?? null;
  const topPriceOf = (t, size) => (t.topping.prices.find((p) => p.sizeLabel === size) || {}).price ?? null;
  const availBases = (item, size) => (item.bases || []).filter((b) => basePriceOf(b, size) !== null);
  const availToppings = (item, size) => (item.toppings || []).filter((t) => t.topping.isActive !== false && topPriceOf(t, size) !== null);
  const hasCustom = (item) => Boolean((item.bases && item.bases.length) || (item.toppings && item.toppings.length));
  const categoryOf = (item) => DATA.catById.get(item.categoryId);
  const activeSpecials = () => DATA.specials.filter((s) => s.isActive !== false);

  // Toppings that are currently out of season but otherwise offered on the item.
  const outOfSeasonToppings = (item, size) =>
    (item.toppings || []).filter((t) => t.topping.isActive !== false && t.topping.isInSeason === false && topPriceOf(t, size) !== null);

  // Affordable in-season substitutes: same item, active + in season + priced at
  // or below the out-of-season topping's price for this size.
  const affordableSwaps = (item, size, target) => {
    const cap = target ? topPriceOf(target, size) : 0;
    return (item.toppings || []).filter((t) =>
      t.topping.isActive !== false && t.topping.isInSeason !== false && t.topping.id !== target?.topping.id &&
      topPriceOf(t, size) !== null && topPriceOf(t, size) <= cap
    );
  };

  // BOGO preview: pay for the higher half of the base prices (extras always paid).
  function bogoBaseTotal(pizzas) {
    const base = (pizzas || []).map((p) => {
      const item = DATA.byId.get(Number(p.itemId));
      const sz = item && sizeRowOf(item, p.sizeLabel);
      return sz ? sz.price : 0;
    }).sort((a, b) => b - a);
    const pay = Math.ceil(base.length / 2);
    return base.slice(0, pay).reduce((s, v) => s + v, 0);
  }
  const extrasTotal = (pizzas) => (pizzas || []).reduce((s, p) => s + (p.extras || []).reduce((a, e) => a + e.price, 0), 0);

  /* --------------------------------------------------------------- catalog */
  async function load() {
    const [catsRes, itemsRes, specialsRes, toppingsRes] = await Promise.all([
      fetch("/api/categories"), fetch("/api/items"), fetch("/api/specials"), fetch("/api/toppings"),
    ]);
    if (!catsRes.ok || !itemsRes.ok || !specialsRes.ok || !toppingsRes.ok) throw new Error("Failed to load menu (API error)");
    const cats = await catsRes.json();
    const items = await itemsRes.json();
    DATA.specials = await specialsRes.json();
    DATA.toppings = await toppingsRes.json();

    try {
      const cfgRes = await fetch("/api/delivery/config");
      if (cfgRes.ok) DATA.delivery = await cfgRes.json();
    } catch { DATA.delivery = null; }

    const activeCats = cats.filter((c) => c.isActive);
    DATA.items = items.filter((i) => i.isActive !== false);
    DATA.byId = new Map(DATA.items.map((i) => [i.id, i]));
    DATA.catById = new Map(cats.map((c) => [c.id, c]));

    const itemsByCat = new Map();
    for (const c of activeCats) itemsByCat.set(c.id, []);
    for (const i of DATA.items) {
      const list = itemsByCat.get(i.categoryId) || [];
      list.push(i);
      itemsByCat.set(i.categoryId, list);
    }
    for (const c of activeCats) {
      c._items = (itemsByCat.get(c.id) || []).slice().sort((a, b) => a.sortOrder - b.sortOrder || a.name.localeCompare(b.name));
    }
    DATA.cats = activeCats.sort((a, b) => a.sortOrder - b.sortOrder);

    const seen = new Set(); const dupes = new Set();
    for (const i of DATA.items) {
      const n = i.name.toLowerCase();
      if (seen.has(n)) dupes.add(n); else seen.add(n);
    }
    DATA.dupeNames = dupes;
    return DATA;
  }

  /* Drop cart lines whose item/special has since vanished or changed size. */
  function reconcile() {
    if (!CART.length) return;
    const specialsById = new Map(activeSpecials().map((s) => [s.id, s]));
    const keep = []; const dropped = [];
    for (const l of CART) {
      if (l.kind === "special" && l.specialId != null) {
        if (!specialsById.has(l.specialId)) { dropped.push(l.name || "special"); continue; }
        keep.push(l);
        continue;
      }
      if (l.kind === "item" && l.itemId != null) {
        const item = DATA.byId.get(l.itemId);
        if (!item) { dropped.push(l.name || "item"); continue; }
        const activeSizes = (item.sizes || []).filter((x) => x.isActive !== false);
        if (activeSizes.length) {
          let sl = l.sizeLabel;
          let sz = activeSizes.find((x) => x.sizeLabel === sl);
          if (!sz) {
            if (activeSizes.length === 1) { sz = activeSizes[0]; sl = sz.sizeLabel; }
            else { dropped.push(l.name || "item"); continue; }
          }
          l.sizeLabel = sl;
          l.unitPrice = sz.price;
        }
        keep.push(l);
        continue;
      }
      keep.push(l);
    }
    if (keep.length !== CART.length) {
      CART.length = 0;
      CART.push(...keep);
      saveCart();
      if (dropped.length) toast("Removed from cart (no longer available): " + dropped.join(", "));
      renderCart();
      syncUI();
    }
  }

  /* -------------------------------------------------------------------- UI */
  function syncUI() {
    const badge = $("#cart-badge");
    if (badge) badge.textContent = count();
    const grand = $("#cart-grand");
    if (grand) grand.textContent = money(total());
    const mcCount = $("#mini-cart-count");
    if (mcCount) mcCount.textContent = count();
    const mcTotal = $("#mini-cart-total");
    if (mcTotal) mcTotal.textContent = money(total());
    const bar = $("#mini-cart");
    if (bar) bar.classList.toggle("show", count() > 0);
    const inCart = new Set();
    for (const l of CART) if (l.kind === "item") inCart.add(l.itemId + "|" + l.sizeLabel);
    for (const b of $$(".sizes button[data-size]")) {
      b.classList.toggle("in-cart", inCart.has(b.dataset.itemId + "|" + b.dataset.size));
    }
  }

  function renderCart() {
    const el = $("#cart-lines");
    if (!el) return;
    if (!CART.length) {
      el.innerHTML = '<div class="empty">Your cart is empty.<br />Head back to the menu to add items.</div>';
      syncUI();
      return;
    }
    el.innerHTML = CART.map((l, idx) => {
      if (l.kind === "special") return renderSpecialLine(l, idx);
      const extrasLine = (l.extras || []).length
        ? '<div class="extras">' + l.extras.map((e) => esc(e.name) + (e.price ? " +" + money(e.price) : "")).join(" &middot; ") + "</div>"
        : "";
      return (
        '<div class="cart-line">' +
        '<div class="top"><span class="name">' + esc(l.name) + '<br /><span class="meta">' + esc(l.sizeLabel || "") + (l.catHint ? " &middot; " + esc(l.catHint) : "") + "</span></span>" +
        '<span class="line-total">' + money((l.unitPrice + (l.extras || []).reduce((a, e) => a + e.price, 0)) * l.qty) + "</span></div>" +
        extrasLine +
        '<div class="foot"><span class="qty"><button data-q="-1" data-idx="' + idx + '">&minus;</button><span class="n">' + l.qty + '</span><button data-q="1" data-idx="' + idx + '">+</button></span>' +
        '<button class="remove" data-remove-idx="' + idx + '">Remove</button></div>' +
        "</div>"
      );
    }).join("");
    syncUI();
  }

  function renderSpecialLine(l, idx) {
    const picks = (l.pizzas || []).map((p) =>
      '<div class="extras">' + esc(p.name || (DATA.byId.get(Number(p.itemId)) || {}).name || "Pizza") + (p.sizeLabel ? " (" + esc(p.sizeLabel) + ")" : "") + "</div>"
    ).join("");
    const meta = l.pizzas
      ? "Pick " + (l.pizzas.length) + ", pay " + Math.ceil(l.pizzas.length / 2) + " | R" + l.unitPrice + " each"
      : "Combo | R" + l.unitPrice + " each";
    return (
      '<div class="cart-line">' +
      '<div class="top"><span class="name">' + esc(l.name) + '</span><span class="line-total">' + money(l.unitPrice * l.qty) + "</span></div>" +
      '<div class="meta">' + meta + "</div>" + picks +
      '<div class="foot"><span class="qty"><button data-q="-1" data-idx="' + idx + '">&minus;</button><span class="n">' + l.qty + '</span><button data-q="1" data-idx="' + idx + '">+</button></span>' +
      '<button class="remove" data-remove-idx="' + idx + '">Remove</button></div>' +
      "</div>"
    );
  }

  function toast(msg) {
    const el = $("#toast");
    if (!el) return;
    el.textContent = msg;
    el.classList.add("show");
    clearTimeout(toast._t);
    toast._t = setTimeout(() => el.classList.remove("show"), 2200);
  }

  /* Wire the cart drawer + shared buttons once, for whichever page loaded us. */
  const hooks = { onCheckout: null, onCartChange: null };

  document.addEventListener("click", (e) => {
    if (e.target.closest('[data-action="open-cart"]')) {
      renderCart();
      const d = $("#cart-drawer");
      if (d) d.classList.add("open");
      return;
    }
    if (e.target.closest('[data-action="close-cart"]')) {
      const d = $("#cart-drawer");
      if (d) d.classList.remove("open");
      return;
    }
    if (e.target.closest('[data-action="checkout"]')) {
      if (hooks.onCheckout) hooks.onCheckout();
      else location.href = "/order?checkout=1";
      return;
    }
    const q = e.target.closest("button[data-q]");
    if (q) { changeQty(Number(q.dataset.idx), Number(q.dataset.q)); return; }
    const rm = e.target.closest("button[data-remove-idx]");
    if (rm) { removeLine(Number(rm.dataset.removeIdx)); return; }
  });

  window.Shop = {
    CART_KEY, $, $$, money, esc,
    lines, count, total, lineKey, addLine, changeQty, removeLine, setLines, clear, renderCart, syncUI,
    sizeRowOf, basePriceOf, topPriceOf, availBases, availToppings, hasCustom, categoryOf, activeSpecials,
    outOfSeasonToppings, affordableSwaps, bogoBaseTotal, extrasTotal,
    load, reconcile, toast, data: DATA, hooks,
    get onCheckout() { return hooks.onCheckout; },
    set onCheckout(fn) { hooks.onCheckout = fn; },
    get onCartChange() { return hooks.onCartChange; },
    set onCartChange(fn) { hooks.onCartChange = fn; },
    get cart() { return CART; },
  };
})();
