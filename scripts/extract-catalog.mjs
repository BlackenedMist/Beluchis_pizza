import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const WORKSPACE = path.resolve(ROOT, "..");
const OUT = path.join(ROOT, "catalog");

const COZA = path.join(WORKSPACE, "menuData", "beluchis-coza-menu.json");
const WORC = path.join(WORKSPACE, "cartDataExtracted", "beluchis-worcester.json");

const EXTRA_TOP_TOPPINGS = "EXTRA TOPPINGS";

const PIZZA_CATEGORIES = new Set([
  "Traditional Pizzas",
  "Deluxe Pizzas",
  "Gourmet Pizzas",
  "Signature Pizza (Large Only)",
  "Napoletana Pizzas",
]);

function slugify(str) {
  return String(str)
    .toLowerCase()
    .replace(/&/g, "and")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function writeJson(name, data) {
  const file = path.join(OUT, name);
  fs.writeFileSync(file, JSON.stringify(data, null, 2));
  console.log(`wrote ${path.relative(ROOT, file)} (${Array.isArray(data) ? data.length : "obj"} entries)`);
}

fs.mkdirSync(OUT, { recursive: true });

const coza = JSON.parse(fs.readFileSync(COZA, "utf8"));
const worc = JSON.parse(fs.readFileSync(WORC, "utf8"));

// ---------------------------------------------------------------- Categories
const categories = coza.categories.map((c) => ({
  name: c.name,
  slug: slugify(c.name),
  description: c.subtitle || null,
  dealText: c.deal || null,
  sortOrder: c.order ?? 0,
  isActive: true,
}));
writeJson("categories.json", categories);

function makeUniqueSlugs(records) {
  const seen = new Map();
  let n = 0;
  for (const r of records) {
    const base = r.slug;
    let slug = base;
    let k = 2;
    while (seen.has(slug)) slug = `${base}-${k++}`;
    seen.set(slug, true);
    r.slug = slug;
    n++;
  }
  return records;
}

// -------------------------------------------------------------------- Items
const extraTopsByName = new Map(coza.products.filter((p) => p.category === EXTRA_TOP_TOPPINGS).map((p) => [p.title, p]));
const items = [];
const extraTopsSeen = new Set();
for (const p of coza.products) {
  if (p.category === EXTRA_TOP_TOPPINGS) {
    for (const raw of p.title.split(",")) {
      const t = raw.trim();
      if (t) extraTopsSeen.add(t);
    }
    continue;
  }
  const sizes = (p.sizes || [])
    .filter((s) => s && Number.isFinite(s.price) && s.price > 0)
    .map((s) => ({ sizeLabel: s.size, price: s.price }));
  items.push({
    name: p.title,
    slug: slugify(p.title),
    description: p.description || null,
    itemType: p.type || "menuitem",
    category: p.category,
    sizes,
    sortOrder: p.menu_order_global ?? items.length,
    isActive: true,
  });
}
writeJson("items.json", makeUniqueSlugs(items));

// ------------------------------------------------------------------ Toppings
const tiers = coza.products.filter((p) => p.category === EXTRA_TOP_TOPPINGS);
const toppings = [];
let tSort = 0;
for (const [tierIdx, p] of tiers.entries()) {
  const sizes = (p.sizes || [])
    .filter((s) => s && Number.isFinite(s.price))
    .map((s) => ({ sizeLabel: s.size, price: s.price }));
  for (const raw of p.title.split(",")) {
    const name = raw.trim();
    if (!name) continue;
    toppings.push({
      name,
      slug: slugify(name),
      tier: tierIdx + 1,
      prices: sizes,
      sortOrder: tSort++,
      isActive: true,
    });
  }
}
writeJson("toppings.json", makeUniqueSlugs(toppings));

// ---------------------------------------------------------------------- Bases
const BASE_MAP = [
  { key: "thin", name: "Thin", sizes: ["S", "M", "L"], price: 0, description: "Standard thin base" },
  { key: "super-thin", name: "Super Thin", sizes: ["S", "M", "L"], price: 0, description: "Extra thin base" },
  { key: "thick", name: "Thick", sizes: ["S", "M", "L"], price: 0, description: "Thick base" },
  { key: "gluten-free", name: "Gluten Free", sizes: ["L"], price: 35, description: "Gluten free base (Large only)" },
  { key: "napoletana", name: "Napoletana", sizes: ["S", "M", "L"], price: 20, description: "Napoletana dough base" },
];

function normalizeBaseKey(label) {
  const l = String(label || "").trim().toLowerCase();
  if (l.startsWith("super thin")) return "super-thin";
  if (l.startsWith("thin")) return "thin";
  if (l.startsWith("thick")) return "thick";
  if (l.startsWith("gluten free")) return "gluten-free";
  if (l.startsWith("napoletana")) return "napoletana";
  return null;
}

const baseSpecs = new Map();
for (const p of worc.products || []) {
  for (const addon of p.addons || []) {
    if (!/^base\b/i.test(addon.name)) continue;
    for (const opt of addon.options || []) {
      const key = normalizeBaseKey(opt.label);
      if (!key) continue;
      baseSpecs.set(key, BASE_MAP.find((b) => b.key === key));
    }
  }
}
const bases = [...baseSpecs.entries()].map(([key, spec], idx) => ({
  name: spec.name,
  slug: key,
  description: spec.description,
  sortOrder: idx,
  isActive: true,
  prices: spec.sizes.map((sizeLabel) => ({ sizeLabel, price: spec.price })),
}));
writeJson("bases.json", bases);

// --------------------------------------------------------------------- Links
const itemTopping = items
  .filter((i) => PIZZA_CATEGORIES.has(i.category))
  .map((i) => ({ itemSlug: i.slug, toppingSlugs: toppings.map((t) => t.slug) }));
const itemBase = items
  .filter((i) => PIZZA_CATEGORIES.has(i.category))
  .map((i) => ({ itemSlug: i.slug, baseSlugs: bases.map((b) => b.slug) }));
writeJson("links.json", { itemTopping, itemBase });