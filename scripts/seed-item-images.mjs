#!/usr/bin/env node
// ---------------------------------------------------------------------------
// Surgical loader: menu images + the two automatic "deal" specials.
//
// This is the safe alternative to `prisma db seed`, which wipes orders and
// customers before rebuilding the catalogue. On the live shop that would
// destroy real orders and every registered customer, so this script only:
//
//   1. attaches ItemImage rows to the existing items (from catalog/item-images.json)
//   2. fills in Item.imageUrl where it is still empty
//   3. creates the two `kind: "deal"` specials for the Traditional pizzas
//
// It never touches orders, customers, favourites, coupons, prices, sizes,
// toppings or bases. Running it twice changes nothing the second time.
//
//   node scripts/seed-item-images.mjs [--dry-run]
// ---------------------------------------------------------------------------
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DRY_RUN = process.argv.includes("--dry-run");

// --- slug matching ---------------------------------------------------------
// The catalogue on origin/main carries a few typos against the slugs the shop
// actually uses ("ppizza-pinata-...", "mediteranean-focacia",
// "ham-and-pinepapple"), so an exact slug match is not always possible. Try
// increasingly forgiving comparisons and only accept a fuzzy match when it is
// unambiguous - a wrong image on the menu is worse than no image.
export const normalise = (s) =>
  String(s || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");

// "ppizza" -> "pizza"
export const collapseRepeats = (s) => normalise(s).replace(/([a-z])\1+/g, "$1");

// Smallest number of single-character edits turning a into b.
export function levenshtein(a, b) {
  if (a === b) return 0;
  if (!a.length) return b.length;
  if (!b.length) return a.length;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i += 1) {
    const row = [i];
    for (let j = 1; j <= b.length; j += 1) {
      row[j] = Math.min(
        prev[j] + 1,
        row[j - 1] + 1,
        prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1),
      );
    }
    prev = row;
  }
  return prev[b.length];
}

// Is `short` obtainable from `long` by deleting characters only?
function isSubsequence(short, long) {
  if (short.length > long.length) return false;
  let i = 0;
  for (const ch of long) {
    if (ch === short[i]) i += 1;
    if (i === short.length) return true;
  }
  return i === short.length;
}

export function buildMatcher(liveSlugs) {
  const prepared = liveSlugs.map((slug) => ({
    slug,
    norm: normalise(slug),
    collapsed: collapseRepeats(slug),
  }));

  return (catalogSlug) => {
    if (liveSlugs.includes(catalogSlug)) return catalogSlug;

    const n = normalise(catalogSlug);
    const c = collapseRepeats(catalogSlug);
    const scored = [];

    for (const cand of prepared) {
      let score = Infinity;
      if (cand.norm === n) score = 1;
      else if (cand.collapsed === c) score = 2;
      else if (cand.norm.includes(n) || n.includes(cand.norm)) score = 3;
      else if (Math.abs(cand.norm.length - n.length) <= 3 && (isSubsequence(cand.norm, n) || isSubsequence(n, cand.norm))) score = 4;
      else {
        const distance = levenshtein(n, cand.norm);
        const allowed = Math.max(1, Math.min(2, Math.floor(Math.min(n.length, cand.norm.length) * 0.2)));
        if (distance <= allowed) score = 5;
      }
      if (score < Infinity) scored.push({ slug: cand.slug, score });
    }

    if (!scored.length) return null;
    scored.sort((a, b) => a.score - b.score);
    // Two equally good candidates means we cannot tell them apart - refuse.
    if (scored.length > 1 && scored[1].score === scored[0].score) return null;
    return scored[0].slug;
  };
}

// --- environment -----------------------------------------------------------
// DATABASE_URL normally comes from the systemd EnvironmentFile. When the
// script is run by hand that file is not loaded, so look for it ourselves.
function readEnvFile(file) {
  const out = {};
  let text;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch {
    return out;
  }
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    let value = trimmed.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"') && value.length > 1) ||
      (value.startsWith("'") && value.endsWith("'") && value.length > 1)
    ) {
      value = value.slice(1, -1);
    }
    out[key] = value;
  }
  return out;
}

function resolveDatabaseUrl() {
  if (process.env.DATABASE_URL) return null;
  const candidates = [
    "/var/lib/beluchis/.env",
    path.join(ROOT, ".env"),
    path.join(ROOT, "server", ".env"),
  ];
  for (const file of candidates) {
    const env = readEnvFile(file);
    if (env.DATABASE_URL) {
      process.env.DATABASE_URL = env.DATABASE_URL;
      console.log(`Loaded DATABASE_URL from ${file}`);
      return file;
    }
  }
  return null;
}

async function main() {
  resolveDatabaseUrl();
  if (!process.env.DATABASE_URL) {
    console.error("DATABASE_URL is not set and could not be found. Aborting without changes.");
    process.exit(1);
  }

  const { PrismaClient } = await import("@prisma/client");
  const prisma = new PrismaClient();

  try {
    const catalogImages = JSON.parse(fs.readFileSync(path.join(ROOT, "catalog", "item-images.json"), "utf8"));
    const catalogItems = JSON.parse(fs.readFileSync(path.join(ROOT, "catalog", "items.json"), "utf8"));

    const liveItems = await prisma.item.findMany({ select: { id: true, slug: true, name: true, imageUrl: true } });
    const liveSlugs = liveItems.map((i) => i.slug);
    const byLiveSlug = new Map(liveItems.map((i) => [i.slug, i]));
    const match = buildMatcher(liveSlugs);

    let imagesAdded = 0;
    let imagesUpdated = 0;
    let imageUrlsFilled = 0;
    const unmatched = [];

    for (const [index, img] of catalogImages.entries()) {
      const liveSlug = match(img.itemSlug);
      if (!liveSlug) {
        unmatched.push(img.itemSlug);
        continue;
      }
      const item = byLiveSlug.get(liveSlug);
      const sortOrder = img.sortOrder ?? index;
      const existing = await prisma.itemImage.findFirst({ where: { itemId: item.id, url: img.url } });
      if (existing) {
        if (existing.sortOrder !== sortOrder || (existing.alt ?? null) !== (img.alt ?? null)) {
          if (!DRY_RUN) {
            await prisma.itemImage.update({
              where: { id: existing.id },
              data: { sortOrder, alt: img.alt ?? null, isActive: true },
            });
          }
          imagesUpdated += 1;
        }
      } else {
        if (!DRY_RUN) {
          await prisma.itemImage.create({
            data: { itemId: item.id, url: img.url, alt: img.alt ?? null, sortOrder, isActive: true },
          });
        }
        imagesAdded += 1;
      }
    }

    // Primary image for every item that still has none.
    const primaryByItem = new Map();
    for (const img of catalogImages) {
      const liveSlug = match(img.itemSlug);
      if (!liveSlug) continue;
      const order = img.sortOrder ?? 0;
      const current = primaryByItem.get(liveSlug);
      if (!current || order < current.order) primaryByItem.set(liveSlug, { order, url: img.url });
    }
    // Items the catalogue has no image file for can still carry a catalogue URL.
    for (const item of catalogItems) {
      if (!item.imageUrl) continue;
      const liveSlug = match(item.slug);
      if (!liveSlug || primaryByItem.has(liveSlug)) continue;
      primaryByItem.set(liveSlug, { order: 0, url: item.imageUrl });
    }

    for (const [liveSlug, primary] of primaryByItem) {
      const item = byLiveSlug.get(liveSlug);
      if (!item.imageUrl) {
        if (!DRY_RUN) await prisma.item.update({ where: { id: item.id }, data: { imageUrl: primary.url } });
        imageUrlsFilled += 1;
      }
    }

    // --- the two automatic deals ---------------------------------------------
    const traditional = await prisma.category.findUnique({ where: { slug: "traditional-pizzas" } });
    const dealRows = [
      { sizeLabel: "L", price: 200 },
      { sizeLabel: "M", price: 150 },
    ];
    let dealsCreated = 0;
    let dealsKept = 0;
    if (traditional) {
      for (const [i, d] of dealRows.entries()) {
        const name = `2 ${d.sizeLabel} Traditional Pizzas`;
        const existing = await prisma.special.findFirst({ where: { kind: "deal", name } });
        if (existing) {
          dealsKept += 1;
          continue;
        }
        if (!DRY_RUN) {
          await prisma.special.create({
            data: {
              kind: "deal",
              name,
              description: `Any 2 ${d.sizeLabel} Traditional Pizzas for R${d.price} — applied automatically in your cart.`,
              price: d.price,
              categoryId: traditional.id,
              sizeLabel: d.sizeLabel,
              count: 2,
              isActive: true,
              showOnHome: false,
              sortOrder: 10 + i,
            },
          });
        }
        dealsCreated += 1;
      }
    }

    const totals = {
      items: liveItems.length,
      imagesAdded,
      imagesUpdated,
      imageUrlsFilled,
      dealsCreated,
      dealsKept,
      unmatchedCatalogueSlugs: unmatched,
    };

    console.log(DRY_RUN ? "[dry-run] would apply:" : "Applied:");
    console.log(JSON.stringify(totals, null, 2));
    if (unmatched.length) {
      console.log(`\nNo shop item matched these catalogue slugs: ${unmatched.join(", ")}`);
    }
    console.log("\nOrders, customers, favourites, coupons, prices, sizes and toppings were not touched.");
  } finally {
    await prisma.$disconnect();
  }
}

const invokedDirectly = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  main();
}
