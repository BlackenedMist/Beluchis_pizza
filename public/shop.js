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
  // Automatic fixed-price deals currently claimed by the cart, recomputed by
  // refreshDeals() on every mutation (see applyDeals).
  let DEALS = { saving: 0, rows: [] };
  // How the customer intends to receive the order. The order page sets this so
  // collection-only specials stop discounting the cart as soon as Delivery is
  // chosen. "any" (home page, before a method is picked) shows everything.
  let FULFILMENT = "any";
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
      ? "s" + l.specialId + "|" + (l.pizzas || []).map((p) =>
          [p.itemId, p.sizeLabel || "", (p.extras || []).map((e) => e.name + ":" + e.price).join(",")].join("~")
        ).join(".") + "|" + (l.payCount || "")
      : "i" + l.itemId + "|" + l.sizeLabel + "|" + (l.extras || []).map((e) => e.name + ":" + e.price).join(",");

  const lines = () => CART;
  const count = () => CART.reduce((s, l) => s + l.qty, 0);
  const gross = () => CART.reduce((s, l) => s + (l.unitPrice + (l.extras || []).reduce((a, e) => a + e.price, 0)) * l.qty, 0);
  // Payable total: the cart at full price, less any automatic deal saving.
  const total = () => Math.max(0, gross() - DEALS.saving);
  const deals = () => DEALS;

  function emit() {
    saveCart();
    refreshDeals();
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
  const pastaPriceOf = (link, size) => ((link && link.pastaType && link.pastaType.prices) || []).find((p) => p.sizeLabel === size)?.price ?? null;
  const availPastaTypes = (item, size) => (item.pastaTypes || [])
    .filter((pt) => pt.pastaType && pt.pastaType.isActive !== false && pastaPriceOf(pt, size) !== null)
    .sort((a, b) => (a.pastaType.sortOrder || 0) - (b.pastaType.sortOrder || 0) || a.pastaType.name.localeCompare(b.pastaType.name));
  const hasCustom = (item) => Boolean((item.bases && item.bases.length) || (item.toppings && item.toppings.length) || (item.pastaTypes && item.pastaTypes.length));
  const categoryOf = (item) => DATA.catById.get(item.categoryId);
  const specialCurrentlyActive = (s) => {
    if (!s || s.isActive === false) return false;
    const now = new Date();
    const dayNames = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
    const todayName = dayNames[now.getDay()];
    if (s.weekdays) {
      const allowed = String(s.weekdays).split(",").map((x) => x.trim()).filter(Boolean);
      if (allowed.length && !allowed.includes(todayName)) return false;
    }
    if (s.startDate) {
      const start = new Date(s.startDate);
      if (now < start) return false;
    }
    if (s.endDate) {
      const end = new Date(s.endDate);
      end.setHours(23, 59, 59, 999);
      if (now > end) return false;
    }
    return true;
  };
  const activeSpecials = () => DATA.specials.filter(specialCurrentlyActive);

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

  // BOGO/pick preview: pay for the `payCount` most expensive base prices
  // (extras always paid). payCount defaults to half when omitted.
  function bogoBaseTotal(pizzas, payCount) {
    const base = (pizzas || []).map((p) => {
      const item = DATA.byId.get(Number(p.itemId));
      const sz = item && sizeRowOf(item, p.sizeLabel);
      return sz ? sz.price : 0;
    }).sort((a, b) => b - a);
    const pay = (payCount && payCount > 0) ? payCount : Math.ceil(base.length / 2);
    return base.slice(0, pay).reduce((s, v) => s + v, 0);
  }
  const extrasTotal = (pizzas) => (pizzas || []).reduce((s, p) => s + (p.extras || []).reduce((a, e) => a + e.price, 0), 0);

  /* ------------------------------------------------------- automatic deals
     Fixed-price specials (kind === "deal") apply themselves: any `count`
     items from the special's category, at the special's size, for a flat
     price - so the customer just adds pizzas normally and the cart does the
     rest. This mirrors POST /api/orders exactly: group the qualifying units
     by size, take floor(n / count) groups cheapest-first, and only reward a
     group when the deal actually beats the normal price (two R90 Margheritas
     stay at R180 rather than being pushed UP to R200). Extras never qualify. */
  function applyDeals(cart) {
    const src = cart || CART;
    const out = { saving: 0, rows: [] };
    const deals = activeSpecials().filter((s) => s.kind === "deal" && s.categoryId != null && s.count >= 1 && s.price > 0 && !(FULFILMENT === "delivery" && s.collectionOnly));
    if (!deals.length || !src.length) return out;

    // A unit is one individual pizza, so a qty-3 line contributes three.
    // `claimed` stops two overlapping deals from discounting the same pizza.
    const claimed = new Set();

    for (const s of deals) {
      const units = [];
      src.forEach((l, idx) => {
        if (l.kind === "special" || l.itemId == null) return;
        const item = DATA.byId.get(l.itemId);
        if (!item || item.categoryId !== s.categoryId) return;
        const sz = sizeRowOf(item, l.sizeLabel);
        if (!sz) return;
        if (s.sizeLabel && l.sizeLabel !== s.sizeLabel) return;
        for (let n = 0; n < (l.qty || 1); n++) {
          const key = idx + ":" + n;
          if (claimed.has(key)) continue;
          units.push({ key, base: sz.price, sizeLabel: l.sizeLabel });
        }
      });
      if (units.length < s.count) continue;

      const sorted = units.slice().sort((a, b) => a.base - b.base);
      if (s.count === 2) {
        // Pair cheapest with most expensive so mixed-price carts still
        // qualify for as many deals as possible (consecutive chunking
        // strands cheap units and under-counts).
        let lo = 0, hi = sorted.length - 1;
        while (lo < hi) {
          const chunk = [sorted[lo], sorted[hi]];
          const normal = chunk.reduce((sum, u) => sum + u.base, 0);
          const saving = Math.max(0, normal - s.price);
          if (saving > 0) {
            chunk.forEach((u) => claimed.add(u.key));
            out.saving += saving;
            out.rows.push({
              id: s.id,
              name: s.name,
              sizeLabel: s.sizeLabel || chunk[0].sizeLabel || "",
              count: s.count,
              price: s.price,
              normal,
              saving,
            });
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
          out.saving += saving;
          out.rows.push({
            id: s.id,
            name: s.name,
            sizeLabel: s.sizeLabel || chunk[0].sizeLabel || "",
            count: s.count,
            price: s.price,
            normal,
            saving,
          });
        }
      }
    }
    return out;
  }

  function refreshDeals() { DEALS = applyDeals(CART); return DEALS; }

  // Called by the order page when the customer switches Delivery/Collection.
  // Recomputes automatic deals so a collection-only deal never shows as a
  // saving on a delivery order.
  function setFulfilment(mode) {
    FULFILMENT = mode === "delivery" ? "delivery" : mode === "collection" ? "collection" : "any";
    refreshDeals();
    renderCart();
    syncUI();
  }

  /* --------------------------------------------------------------- catalog */
  async function load() {
    const [catsRes, itemsRes, specialsRes] = await Promise.all([
      fetch("/api/categories"), fetch("/api/items"), fetch("/api/specials"),
    ]);
    if (!catsRes.ok || !itemsRes.ok || !specialsRes.ok) throw new Error("Failed to load menu (API error)");
    const cats = await catsRes.json();
    const items = await itemsRes.json();
    DATA.specials = await specialsRes.json();

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
    refreshDeals();
    return DATA;
  }

  /* Drop cart lines whose item/special has since vanished or changed size. */
  function reconcile() {
    if (!CART.length) return;
    const specialsById = new Map(activeSpecials().map((s) => [s.id, s]));
    const keep = []; const dropped = [];
    for (const l of CART) {
      if (l.kind === "special" && l.specialId != null) {
        const sp = specialsById.get(l.specialId);
        // A fixed-price deal never sits in the cart as a line - it applies
        // itself, so drop any stale copy an older cart may still hold.
        if (!sp || sp.kind === "deal") { dropped.push(l.name || "special"); continue; }
        l.collectionOnly = Boolean(sp.collectionOnly);
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
        // Keep a pasta-type choice honest across menu edits/deletions and price
        // changes; if the type is gone, charge nothing for it and drop the row.
        if (l.pastaTypeId != null) {
          const link = (item.pastaTypes || []).find((pt) => pt.pastaType && pt.pastaType.id === Number(l.pastaTypeId));
          const price = link ? pastaPriceOf(link, l.sizeLabel) : null;
          l.extras = (l.extras || []).filter((e) => !/^Pasta:\s/i.test(e.name || ""));
          if (link && price !== null) {
            l.extras.push({ name: "Pasta: " + link.pastaType.name, price: price || 0 });
          } else {
            l.pastaTypeId = null;
          }
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
      refreshDeals();
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
    }).join("") +
    DEALS.rows.map(dealRow).join("");
    syncUI();
  }

  /* Highlight row for an automatic deal the cart has claimed. */
  function dealRow(d) {
    return (
      '<div class="cart-line deal-line">' +
      '<div class="top"><span class="name">' + esc(d.name) +
      '<br /><span class="meta">' + d.count + " &times; " + money(d.price / d.count) + " = " + money(d.price) +
      (d.sizeLabel ? " &middot; " + esc(d.sizeLabel) : "") + "</span></span>" +
      '<span class="line-total"><s>' + money(d.normal) + "</s> " + money(d.price) + "</span></div>" +
      '<div class="meta">You save ' + money(d.saving) + "</div>" +
      "</div>"
    );
  }

  function renderSpecialLine(l, idx) {
    const picks = (l.pizzas || []).map((p) =>
      '<div class="extras">' + esc(p.name || (DATA.byId.get(Number(p.itemId)) || {}).name || "Pizza") + (p.sizeLabel ? " (" + esc(p.sizeLabel) + ")" : "") + "</div>"
    ).join("");
    const bundle = l.pizzas
      ? ""
      : ((DATA.specials.find((x) => x.id === l.specialId) || {}).items || []).map((si) => {
          let extras = [];
          try { extras = si.extras ? JSON.parse(si.extras) : []; } catch (e) { extras = []; }
          const extrasTxt = extras.length ? " + " + extras.map((e) => esc(e.name)).join(", ") : "";
          return '<div class="extras">' + (si.quantity > 1 ? si.quantity + "&times; " : "") + esc(si.item.name) + (si.sizeLabel ? " (" + esc(si.sizeLabel) + ")" : "") + extrasTxt + "</div>";
        }).join("");
    const meta = l.pizzas
      ? "Pick " + (l.pizzas.length) + ", pay for " + (l.payCount || Math.ceil(l.pizzas.length / 2)) + " | R" + l.unitPrice + " each"
      : "Combo | R" + l.unitPrice + " each";
    return (
      '<div class="cart-line">' +
      '<div class="top"><span class="name">' + esc(l.name) + (l.collectionOnly ? ' <span class="meta">(Collection only)</span>' : "") + '</span><span class="line-total">' + money(l.unitPrice * l.qty) + "</span></div>" +
      '<div class="meta">' + meta + "</div>" + picks + bundle +
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
    lines, count, total, gross, deals, lineKey, addLine, changeQty, removeLine, setLines, clear, renderCart, syncUI,
    sizeRowOf, basePriceOf, topPriceOf, availBases, availToppings, hasCustom, categoryOf, activeSpecials, specialCurrentlyActive,
    pastaPriceOf, availPastaTypes,
    outOfSeasonToppings, affordableSwaps, bogoBaseTotal, extrasTotal, applyDeals, refreshDeals, setFulfilment,
    load, reconcile, toast, data: DATA, hooks,
    get fulfilment() { return FULFILMENT; },
    get onCheckout() { return hooks.onCheckout; },
    set onCheckout(fn) { hooks.onCheckout = fn; },
    get onCartChange() { return hooks.onCartChange; },
    set onCartChange(fn) { hooks.onCartChange = fn; },
    get cart() { return CART; },
  };
})();
