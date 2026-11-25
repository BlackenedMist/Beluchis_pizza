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
  // Generic option sets: one flat-priced choice per set. A set with a size
  // label only applies to that size; a set without one applies to every size.
  const availOptionSets = (item, size) => (item.optionSets || [])
    .map((link) => link.optionSet)
    .filter((s) => s && s.isActive !== false && (!s.sizeLabel || s.sizeLabel === size))
    .filter((s) => (s.values || []).some((v) => v.isActive !== false))
    .sort((a, b) => (a.sortOrder || 0) - (b.sortOrder || 0) || a.name.localeCompare(b.name));
  const optionExtraName = (set, value) => (set.receiptName || set.name) + ": " + value.name;
  const findOptionValue = (item, setId, valueId, sizeLabel) => {
    for (const link of item.optionSets || []) {
      const set = link.optionSet;
      if (!set || set.isActive === false || (setId != null && set.id !== Number(setId))) continue;
      if (set.sizeLabel && set.sizeLabel !== sizeLabel) continue;
      const value = (set.values || []).find((v) => v.id === Number(valueId) && v.isActive !== false);
      if (value) return { set, value };
    }
    return null;
  };
  const hasCustom = (item) => Boolean((item.bases && item.bases.length) || (item.toppings && item.toppings.length) || (item.pastaTypes && item.pastaTypes.length) || (item.optionSets && item.optionSets.length));
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

  /* --------------------------------------------- special cart line breakdown
     These helpers mirror POST /api/orders pricing so the cart can list every
     item inside a special with its own (charged) price, mark free items FREE,
     and show one special total at the end of the line. */
  const specialById = (id) => (DATA.specials || []).find((s) => s.id === Number(id)) || null;
  const basePriceOfPick = (pick, item) => {
    const src = item || DATA.byId.get(Number(pick && pick.itemId));
    const sz = src && (src.sizes || []).find((x) => x.sizeLabel === (pick && pick.sizeLabel) && x.isActive !== false);
    return sz ? Number(sz.price) || 0 : 0;
  };
  const extrasOfPick = (pick) => ((pick && pick.extras) || []).reduce((s, e) => s + (Number(e && e.price) || 0), 0);

  const bundleGroupsOf = (sp) => {
    try {
      const raw = sp && sp.bundleSpec;
      const parsed = typeof raw === "string" ? JSON.parse(raw) : raw;
      return Array.isArray(parsed) ? parsed : [];
    } catch { return []; }
  };
  const bundleGroupIndexOf = (groups, idx) => {
    let acc = 0;
    for (let i = 0; i < groups.length; i++) {
      acc += Number(groups[i].count || 0);
      if (idx < acc) return i;
    }
    return Math.max(0, groups.length - 1);
  };
  // Charge per pick inside one bundle group. The sum of these is exactly what
  // the order page's bundleGroupPrice() returns for the same group.
  function bundlePickPrices(g, picks) {
    const out = picks.map(() => 0);
    if (!g || g.paid === false) return out;
    const mode = g.priceMode || "value";
    const bases = picks.map((p) => basePriceOfPick(p));
    if (mode === "fixed") { if (out.length) out[0] = Number(g.price) || 0; return out; }
    if (mode === "each") return picks.map(() => Number(g.price) || 0);
    if (mode === "cheapest") {
      const freeN = Math.min(bases.length, Math.max(1, Number(g.freeCount) || 1));
      bases.map((b, i) => ({ b, i })).sort((a, b) => b.b - a.b)
        .slice(0, Math.max(0, bases.length - freeN))
        .forEach((o) => { out[o.i] = o.b; });
      return out;
    }
    if (mode === "highest") {
      let top = -1, val = -1;
      bases.forEach((b, i) => { if (b > val) { val = b; top = i; } });
      if (top >= 0) out[top] = val;
      return out;
    }
    return bases.slice();
  }
  const bundleGroupPrice = (g, picks) => bundlePickPrices(g, picks).reduce((a, b) => a + b, 0);
  const bundlePickBase = (p) => basePriceOfPick(p);
  const bundleGroups = (sp) => bundleGroupsOf(sp);

  function specialBreakdown(line) {
    const sp = specialById(line && line.specialId);
    const kind = String((sp && sp.kind) || "flat").toLowerCase();
    const qty = Math.max(1, Number(line && line.qty) || 1);
    const rows = [];

    const addRow = (name, sizeLabel, extras, quantity, price, free) => {
      const n = Number(quantity) > 1 ? Number(quantity) + "× " : "";
      const sz = sizeLabel ? " (" + esc(sizeLabel) + ")" : "";
      const ex = (extras || []).length ? " + " + extras.map((e) => esc(e.name || e)).join(", ") : "";
      rows.push({
        label: n + esc(name || "Item") + sz + ex,
        price: Math.max(0, Number(price) || 0),
        free: Boolean(free) || (Number(price) || 0) <= 0,
      });
    };

    const pizzas = Array.isArray(line && line.pizzas) ? line.pizzas : [];
    if (pizzas.length && kind === "bundle") {
      const groups = bundleGroupsOf(sp);
      const byGroup = groups.map(() => []);
      pizzas.forEach((p, i) => {
        const gi = bundleGroupIndexOf(groups, i);
        (byGroup[gi] = byGroup[gi] || []).push(i);
      });
      const prices = new Array(pizzas.length).fill(0);
      groups.forEach((g, gi) => {
        const idxs = byGroup[gi] || [];
        const charges = bundlePickPrices(g, idxs.map((i) => pizzas[i]));
        idxs.forEach((i, k) => { prices[i] = charges[k] || 0; });
      });
      pizzas.forEach((p, i) => {
        const ex = extrasOfPick(p);
        addRow(p.name, p.sizeLabel, p.extras, 1, prices[i] + ex, prices[i] === 0 && ex === 0);
      });
    } else if (pizzas.length) {
      // BOGO / pick N pay M: the most expensive picks are paid, the rest free
      // (or use the special's fixed paid flags when configured that way).
      const count = pizzas.length;
      const payCount = line.payCount != null
        ? Math.max(0, Number(line.payCount) || 0)
        : (kind === "pick" ? Math.max(1, count - 1) : Math.ceil(count / 2));
      const bases = pizzas.map((p) => basePriceOfPick(p));
      const need = Math.max(0, count - payCount);
      const free = new Set();
      const paidMap = new Map((sp && Array.isArray(sp.items) ? sp.items : [])
        .map((si) => [Number(si.itemId), si.paid !== false]));
      if (sp && sp.payMode === "fixed" && paidMap.size) {
        pizzas.forEach((p, i) => {
          const id = Number(p.itemId);
          if (paidMap.has(id) && paidMap.get(id) === false) free.add(i);
        });
        bases.map((b, i) => ({ b, i })).filter((o) => !free.has(o.i))
          .sort((a, b) => a.b - b.b).slice(0, Math.max(0, need - free.size))
          .forEach((o) => free.add(o.i));
      } else {
        bases.map((b, i) => ({ b, i })).sort((a, b) => a.b - b.b).slice(0, need)
          .forEach((o) => free.add(o.i));
      }
      pizzas.forEach((p, i) => {
        const ex = extrasOfPick(p);
        addRow(p.name, p.sizeLabel, p.extras, 1, (free.has(i) ? 0 : bases[i]) + ex, free.has(i) && ex === 0);
      });
    } else {
      // Flat / combo: the special's own items; paid:false means free.
      const items = (sp && Array.isArray(sp.items)) ? sp.items : [];
      for (const si of items) {
        const it = si.item || DATA.byId.get(Number(si.itemId));
        let ex = [];
        try { ex = typeof si.extras === "string" ? JSON.parse(si.extras || "[]") : (si.extras || []); } catch { ex = []; }
        const isFree = si.paid === false;
        addRow(it && it.name ? it.name : ("Item " + si.itemId), si.sizeLabel, ex, si.quantity || 1,
          isFree ? 0 : basePriceOfPick({ itemId: si.itemId, sizeLabel: si.sizeLabel }, it), isFree);
      }
    }
    return { rows, total: (Number(line && line.unitPrice) || 0) * qty, qty };
  }

  /* ------------------------------------------------------- automatic deals
     Fixed-price specials (kind === "deal") apply themselves: any `count`
     items from the special's category, at the special's size, for a flat
     price - so the customer just adds pizzas normally and the cart does the
     rest. This mirrors POST /api/orders exactly: group the qualifying units
     by size, take floor(n / count) groups cheapest-first, and only reward a
     group when the deal actually beats the normal price (two R90 Margheritas
     stay at R180 rather than being pushed UP to R200). Extras never qualify. */
  // Eligible categories for an automatic deal. The server sends `dealPicks`
  // directly; older payloads only carry one categoryId.
  function dealPicksOf(s) {
    if (Array.isArray(s.dealPicks) && s.dealPicks.length) return s.dealPicks;
    if (s.categoryId != null) return [{ categoryId: s.categoryId, sizeLabel: s.sizeLabel || null }];
    return [];
  }
  function dealModeOf(s) { return s.dealMode === "each" ? "each" : "union"; }

  function applyDeals(cart) {
    const src = cart || CART;
    const out = { saving: 0, rows: [] };
    const deals = activeSpecials().filter((s) => s.kind === "deal" && s.count >= 1 && s.price > 0 && !(FULFILMENT === "delivery" && s.collectionOnly));
    if (!deals.length || !src.length) return out;

    // A unit is one individual pizza, so a qty-3 line contributes three.
    // `claimed` stops two overlapping deals from discounting the same pizza.
    const claimed = new Set();
    const reward = (s, chunk) => {
      const normal = chunk.reduce((sum, u) => sum + u.base, 0);
      const saving = Math.max(0, normal - s.price);
      if (saving <= 0) return false;
      chunk.forEach((u) => claimed.add(u.key));
      out.saving += saving;
      out.rows.push({
        id: s.id,
        name: s.name,
        sizeLabel: s.sizeLabel || chunk[0].sizeLabel || "",
        count: chunk.length,
        price: s.price,
        normal,
        saving,
      });
      return true;
    };

    for (const s of deals) {
      const picks = dealPicksOf(s);
      if (!picks.length) continue;
      const mode = dealModeOf(s);
      const units = [];
      src.forEach((l, idx) => {
        if (l.kind === "special" || l.itemId == null) return;
        const item = DATA.byId.get(l.itemId);
        if (!item) return;
        const sz = sizeRowOf(item, l.sizeLabel);
        if (!sz) return;
        picks.forEach((p, pickIdx) => {
          if (item.categoryId !== p.categoryId) return;
          if (p.sizeLabel && l.sizeLabel !== p.sizeLabel) return;
          for (let n = 0; n < (l.qty || 1); n++) {
            const key = idx + ":" + n;
            if (claimed.has(key)) continue;
            units.push({ key, base: sz.price, sizeLabel: l.sizeLabel, pickIdx });
          }
        });
      });

      if (mode === "each") {
        while (true) {
          const chunk = picks.map((_, idx) => units
            .filter((u) => u.pickIdx === idx && !claimed.has(u.key))
            .sort((a, b) => a.base - b.base)[0]);
          if (chunk.some((u) => !u)) break;
          if (!reward(s, chunk)) chunk.forEach((u) => claimed.add(u.key));
        }
      } else {
        const sorted = units.slice().sort((a, b) => a.base - b.base);
        if (sorted.length < s.count) continue;
        if (s.count === 2) {
          let lo = 0, hi = sorted.length - 1;
          while (lo < hi) {
            if (!reward(s, [sorted[lo], sorted[hi]])) { lo++; continue; }
            lo++; hi--;
          }
        } else {
          for (let i = 0; i + s.count <= sorted.length; i += s.count)
            reward(s, sorted.slice(i, i + s.count));
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
        // Move a legacy pasta choice onto its migrated option set when one
        // exists, so old carts keep the same label and correctly repriced cost.
        if (l.pastaTypeId != null) {
          for (const link of item.optionSets || []) {
            const set = link.optionSet;
            const value = set && (set.values || []).find(
              (v) => v.legacyType === "pastaType" && v.legacyId === Number(l.pastaTypeId) &&
                (v.legacySizeLabel || null) === (l.sizeLabel || null) && v.isActive !== false
            );
            if (value) {
              l.optionValueIds = [...new Set([...(l.optionValueIds || []), value.id])];
              l.pastaTypeId = null;
              break;
            }
          }
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
        // Reprice generic option-set choices from the current menu data and
        // drop any value that has since been deleted, disabled or repriced.
        if (Array.isArray(l.optionValueIds) && l.optionValueIds.length) {
          const nextIds = [];
          for (const rawId of l.optionValueIds) {
            const found = findOptionValue(item, null, rawId, l.sizeLabel);
            if (!found) continue;
            const escaped = (found.set.receiptName || found.set.name).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
            l.extras = (l.extras || []).filter((e) => !new RegExp("^" + escaped + ":\\s", "i").test(e.name || ""));
            l.extras.push({ name: optionExtraName(found.set, found.value), price: Number(found.value.price) || 0 });
            nextIds.push(found.value.id);
          }
          l.optionValueIds = nextIds;
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
    const b = specialBreakdown(l);
    const meta = (l.pizzas || []).length
      ? "Pick " + l.pizzas.length + ", pay for " + (l.payCount || Math.ceil(l.pizzas.length / 2)) + " | R" + l.unitPrice + " each"
      : "Combo | R" + l.unitPrice + " each";
    const subItems = b.rows.map((r) =>
      '<div class="sub-item"><span class="sub-label">' + r.label + '</span>' +
      '<span class="sub-price' + (r.free ? " free" : "") + '">' + (r.free ? "FREE" : money(r.price)) + "</span></div>"
    ).join("");
    return (
      '<div class="cart-line special-line">' +
      '<div class="top"><span class="name">' + esc(l.name) + (l.collectionOnly ? ' <span class="meta">(Collection only)</span>' : "") + "</span></div>" +
      '<div class="meta">' + meta + "</div>" +
      subItems +
      '<div class="special-total"><span>Special total</span><span>' + money(b.total) + "</span></div>" +
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
    pastaPriceOf, availPastaTypes, availOptionSets, optionExtraName, findOptionValue,
    outOfSeasonToppings, affordableSwaps, bogoBaseTotal, extrasTotal, applyDeals, refreshDeals, setFulfilment,
    specialBreakdown, bundleGroups, bundleGroupIndex: bundleGroupIndexOf, bundleGroupPrice, bundlePickBase,
    load, reconcile, toast, data: DATA, hooks,
    get fulfilment() { return FULFILMENT; },
    get onCheckout() { return hooks.onCheckout; },
    set onCheckout(fn) { hooks.onCheckout = fn; },
    get onCartChange() { return hooks.onCartChange; },
    set onCartChange(fn) { hooks.onCartChange = fn; },
    get cart() { return CART; },
  };
})();
