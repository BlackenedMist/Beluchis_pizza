/* Shared, framework-free text for specials.
   Used by the storefront (home + order) and the admin preview so the offer
   the owner types is the offer the customer reads. Plain text only - callers
   escape when injecting into HTML. */
(function (global) {
  "use strict";

  const money = (n) => "R" + (Number.isInteger(Number(n)) ? Number(n) : Number(n || 0).toFixed(2));
  const clean = (v) => (v == null ? "" : String(v).trim());

  const categoryName = (s) => clean(s && s.category && s.category.name);
  const sizeLabel = (s) => clean(s && s.sizeLabel);
  const isCollectionOnly = (s) => Boolean(s && s.collectionOnly);

  /* Buy/pay counts for the "buy N, get M free" family. Legacy `bogo` rows
     always pay half; `pick` rows carry explicit buyCount/payCount. */
  function pickCounts(s) {
    if (!s) return { buy: 0, pay: 0, free: 0 };
    if (s.kind === "bogo") {
      const buy = Number(s.count) || 2;
      const pay = Math.ceil(buy / 2);
      return { buy, pay, free: buy - pay };
    }
    const buy = Number(s.buyCount || s.count) || 2;
    const pay = Number(s.payCount || Math.max(1, buy - 1));
    return { buy, pay, free: Math.max(0, buy - pay) };
  }

  function bundleGroups(s) {
    let spec = s && s.bundleSpec;
    if (typeof spec === "string") {
      try { spec = JSON.parse(spec); } catch (e) { spec = []; }
    }
    return Array.isArray(spec) ? spec : [];
  }

  function itemList(s) {
    return (s && s.items ? s.items : [])
      .map((x) => {
        const name = x.item ? x.item.name : x.name || "";
        const size = x.sizeLabel ? " (" + x.sizeLabel + ")" : "";
        const qty = Number(x.quantity) > 1 ? x.quantity + "\u00d7 " : "";
        return qty + name + size;
      })
      .filter(Boolean)
      .join(" + ");
  }

  function kindLabel(s) {
    switch (s && s.kind) {
      case "bogo": return "Weekly deal";
      case "pick": return "Multi-buy deal";
      case "deal": return "Automatic deal";
      case "bundle": return "Build your own";
      case "flat": return "Special";
      default: return "Special";
    }
  }

  /* The big marketing line on a home tile/banner or deal card. */
  function headline(s) {
    if (!s) return "";
    if (clean(s.homeHeadline)) return clean(s.homeHeadline);
    const cat = categoryName(s);
    const size = sizeLabel(s);
    if (s.kind === "pick" || s.kind === "bogo") {
      const c = pickCounts(s);
      if (c.free > 0) return "Buy " + c.pay + ", get " + c.free + " free";
      return "Buy " + c.buy + ", save more";
    }
    if (s.kind === "deal") {
      const who = [size, cat].filter(Boolean).join(" ");
      return "Any " + (Number(s.count) || 2) + (who ? " " + who : "") + " for " + money(s.price);
    }
    if (s.kind === "bundle") {
      if (Number(s.price) > 0) return "Bundle for " + money(s.price);
      return "Build your own bundle";
    }
    if (Number(s.price) > 0) return "Just " + money(s.price);
    return clean(s.name);
  }

  /* Supporting line. Custom copy wins; otherwise a plain-English explanation
     of the mechanics (never "pick N, pay N/2"). */
  function subtext(s) {
    if (!s) return "";
    if (clean(s.homeSubtext)) return clean(s.homeSubtext);
    const cat = categoryName(s);
    const size = sizeLabel(s);
    if (s.kind === "pick" || s.kind === "bogo") {
      const c = pickCounts(s);
      const choose = "Choose any " + c.buy + " " + (size ? size + " " : "") + (cat || "items");
      if (c.free > 0) return choose + (c.free === 1 ? " \u2014 the cheapest one is free." : " \u2014 the cheapest " + c.free + " are free.");
      return choose + " and pay for " + c.pay + ".";
    }
    if (s.kind === "deal") {
      return "Add " + (Number(s.count) || 2) + (size ? " " + size : "") + (cat ? " " + cat : "") + " \u2014 the saving lands in your cart automatically.";
    }
    if (s.kind === "bundle") {
      const groups = bundleGroups(s);
      if (groups.length) {
        return groups
          .map((g) => Number(g.count || 0) + "\u00d7 " + (g.sizeLabel || "") + (g.name ? " " + g.name : ""))
          .join(" + ");
      }
    }
    if (clean(s.description)) return clean(s.description);
    return itemList(s);
  }

  /* Price label. Custom copy wins; dynamic offers say what you pay for. */
  function priceText(s) {
    if (!s) return "";
    if (clean(s.homePriceText)) return clean(s.homePriceText);
    if (s.kind === "pick" || s.kind === "bogo") {
      const c = pickCounts(s);
      return c.pay > 0 ? "Pay for " + c.pay : "";
    }
    if (Number(s.price) > 0) return money(s.price);
    return "";
  }

  /* Optional promo badge (e.g. "SAVE R89"). Collection-only is rendered
     separately by the storefront so it can never be overwritten. */
  function badge(s) {
    return clean(s && s.homeBadge);
  }

  /* Pictures to advertise a special with. The owner's upload wins; otherwise
     use the dishes inside the offer (curated rows first, then every active
     item in the special's category when `allItems` is supplied). */
  function images(s, allItems) {
    const out = [];
    const push = (url) => {
      const u = clean(url);
      if (u && !out.includes(u)) out.push(u);
    };
    const addItem = (item) => {
      if (!item) return;
      push(item.imageUrl);
      for (const im of item.images || []) {
        if (im && im.isActive !== false) push(im.url);
      }
    };
    if (!s) return out;
    push(s.imageUrl);
    if (Array.isArray(s.items)) for (const si of s.items) addItem(si && (si.item || si));
    if (allItems) {
      const catIds = new Set();
      const itemIds = new Set();
      if (s.categoryId != null) catIds.add(Number(s.categoryId));
      for (const g of bundleGroups(s)) {
        for (const c of g.categories || []) catIds.add(Number(c));
        for (const id of g.itemIds || []) itemIds.add(Number(id));
      }
      for (const it of allItems) {
        if (it.isActive === false) continue;
        if (itemIds.size ? itemIds.has(Number(it.id)) : catIds.has(Number(it.categoryId))) addItem(it);
      }
    }
    return out.slice(0, 8);
  }

  /* Cross-fade any [data-special-slides] block. Safe to call after every
     render; blocks already running are left alone. */
  function mountSlideshows(root) {
    const host = root || (typeof document !== "undefined" ? document : null);
    if (!host || !host.querySelectorAll) return;
    // Respect reduced-motion: leave the first photo in place.
    if (typeof window !== "undefined" && window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    host.querySelectorAll("[data-special-slides]").forEach((el) => {
      if (el.__slidesTimer) return;
      const pics = Array.from(el.querySelectorAll("img"));
      if (pics.length < 2) return;
      let i = 0;
      el.__slidesTimer = setInterval(() => {
        if (!el.isConnected) { clearInterval(el.__slidesTimer); el.__slidesTimer = null; return; }
        pics[i].classList.remove("on");
        i = (i + 1) % pics.length;
        pics[i].classList.add("on");
      }, 3000);
    });
  }

  /* One-line summary for the admin builder / list. */
  function summary(s) {
    if (!s) return "";
    const cat = categoryName(s);
    const size = sizeLabel(s);
    const who = [size, cat].filter(Boolean).join(" ");
    if (s.kind === "pick" || s.kind === "bogo") {
      const c = pickCounts(s);
      const what = who ? " " + who : "";
      if (c.free > 0) return "Buy " + c.pay + what + ", get " + c.free + " free (cheapest free).";
      return "Buy " + c.buy + what + ", pay for " + c.pay + ".";
    }
    if (s.kind === "deal") {
      return "Any " + (Number(s.count) || 2) + (who ? " " + who : "") + " for " + money(s.price) + " (applied automatically).";
    }
    if (s.kind === "bundle") {
      const groups = bundleGroups(s);
      const parts = groups.map((g) => Number(g.count || 0) + "\u00d7 " + (g.sizeLabel || "") + (g.name ? " " + g.name : "")).join(" + ");
      return (parts || "Bundle") + (Number(s.price) > 0 ? " for " + money(s.price) : "") + ".";
    }
    return (clean(s.name) || "Special") + (Number(s.price) > 0 ? " for " + money(s.price) : "") + ".";
  }

  const api = {
    money, headline, subtext, priceText, badge, summary,
    kindLabel, pickCounts, bundleGroups, itemList,
    categoryName, sizeLabel, isCollectionOnly, images, mountSlideshows,
  };
  global.SpecialDisplay = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})(typeof window !== "undefined" ? window : globalThis);
