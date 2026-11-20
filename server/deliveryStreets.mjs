import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

const ENDPOINTS = [
  "https://overpass.kumi.systems/api/interpreter",
  "https://maps.mail.ru/osm/tools/overpass/api/interpreter",
  "https://overpass-api.de/api/interpreter",
];
const USER_AGENT = "BeluchisDelivery/1.0 (delivery-zone street refresh)";
const REQUEST_TIMEOUT_MS = 150000;

const toRad = (x) => (x * Math.PI) / 180;
export function haversineKm(a, b) {
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const s = Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * 6371 * Math.asin(Math.sqrt(s));
}

const num = (value, fallback) => {
  // BUG-1: a blank Setting must use the fallback, never become 0 (Number("")).
  if (value == null || String(value).trim() === "") return fallback;
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
};

async function settingsMap() {
  const rows = await prisma.setting.findMany();
  return Object.fromEntries(rows.map((r) => [r.key, r.value]));
}

/** Derive the zone bands from the same Setting rows the order pricing uses. */
export function zonesFromSettings(s) {
  const shop = {
    lat: num(s["shop.lat"], -33.646),
    lng: num(s["shop.lng"], 19.448),
  };
  const free = Math.max(0, num(s["delivery.freeRadiusKm"], 3));
  const max = Math.max(free, num(s["delivery.maxRadiusKm"], 10));
  const fee = Math.max(0, num(s["delivery.feeAmount"], 85));
  const beyondFee = Math.max(0, num(s["delivery.beyondFeeAmount"], 95));
  const cutoffRaw = String(s["delivery.noDeliveryRadiusKm"] ?? "").trim();
  const cutoffNum = cutoffRaw === "" ? null : num(cutoffRaw, NaN);
  const cutoff = cutoffNum == null || !Number.isFinite(cutoffNum)
    ? null
    : Math.max(max, cutoffNum);

  const zones = [
    { id: "free", label: `Free delivery (0-${free}km)`, color: "#2d8a4e", minKm: 0, maxKm: free, fee: 0, type: "free" },
    { id: "standard", label: `Delivery R${fee} (${free}-${max}km)`, color: "#f1c40f", minKm: free, maxKm: max, fee, type: "paid" },
  ];
  if (cutoff == null) {
    zones.push({ id: "beyond", label: `Delivery R${beyondFee} (beyond ${max}km)`, color: "#e67e22", minKm: max, maxKm: null, fee: beyondFee, type: "paid" });
  } else {
    zones.push({ id: "beyond", label: `Delivery R${beyondFee} (${max}-${cutoff}km)`, color: "#e67e22", minKm: max, maxKm: cutoff, fee: beyondFee, type: "paid" });
    zones.push({ id: "none", label: `No delivery (${cutoff}km+)`, color: "#c0392b", minKm: cutoff, maxKm: null, fee: null, type: "none" });
  }
  return { shop, zones, currency: "ZAR" };
}

export async function getZones() {
  return zonesFromSettings(await settingsMap());
}

export async function getStreetStatus() {
  const s = await settingsMap();
  let counts = {};
  try { counts = JSON.parse(s["delivery.streetsCounts"] || "{}"); } catch {}
  return {
    refreshedAt: s["delivery.streetsRefreshedAt"] || null,
    counts,
    lastError: s["delivery.streetsLastError"] || null,
  };
}

function classify(zones, distanceKm) {
  for (const z of zones) {
    if (distanceKm >= z.minKm && (z.maxKm == null || distanceKm < z.maxKm)) return z;
  }
  return zones[zones.length - 1];
}

async function fetchOverpass(radiusM, shop) {
  const query = `[out:json][timeout:120];way["highway"]["name"](around:${Math.round(radiusM)},${shop.lat},${shop.lng});out center tags;`;
  let lastError = null;
  for (const endpoint of ENDPOINTS) {
    for (let attempt = 0; attempt < 2; attempt++) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
      try {
        const res = await fetch(endpoint + "?data=" + encodeURIComponent(query), {
          headers: { "User-Agent": USER_AGENT, Accept: "application/json" },
          signal: controller.signal,
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const text = await res.text();
        if (!text.trim().startsWith("{")) throw new Error("non-JSON response");
        const json = JSON.parse(text);
        if (!Array.isArray(json.elements) || json.elements.length === 0) throw new Error("empty result");
        return json.elements;
      } catch (err) {
        lastError = err.message;
        clearTimeout(timer);
        await new Promise((r) => setTimeout(r, 1000 * (attempt + 1)));
      } finally {
        clearTimeout(timer);
      }
    }
  }
  throw new Error(`Overpass fetch failed: ${lastError || "unknown error"}`);
}

/** Fetch named streets from OSM and store the nearest representative point per band. */
export async function refreshDeliveryStreets() {
  const started = Date.now();
  const s = await settingsMap();
  const cfg = zonesFromSettings(s);
  const outer = cfg.zones.reduce((m, z) => Math.max(m, z.maxKm ?? z.minKm + 5), 0);
  const elements = await fetchOverpass((outer + 1) * 1000, cfg.shop);

  const best = new Map(); // name|zoneId -> { name, lat, lng, zoneId, wayCount, dist }
  for (const el of elements) {
    const name = el.tags?.name;
    if (!name || !el.center || !Number.isFinite(el.center.lat) || !Number.isFinite(el.center.lon)) continue;
    const point = { lat: el.center.lat, lng: el.center.lon };
    const dist = haversineKm(cfg.shop, point);
    const zone = classify(cfg.zones, dist);
    const key = `${name}|${zone.id}`;
    const existing = best.get(key);
    if (existing) {
      existing.wayCount += 1;
      if (dist < existing.dist) { existing.lat = point.lat; existing.lng = point.lng; existing.dist = dist; }
    } else {
      best.set(key, { name, lat: point.lat, lng: point.lng, zoneId: zone.id, wayCount: 1, dist });
    }
  }

  const validZones = cfg.zones.map((z) => z.id);
  await prisma.$transaction([
    prisma.deliveryStreet.deleteMany({ where: { zoneId: { notIn: validZones } } }),
    ...[...best.values()].map((row) => prisma.deliveryStreet.upsert({
      where: { name_zoneId: { name: row.name, zoneId: row.zoneId } },
      update: { lat: row.lat, lng: row.lng, wayCount: row.wayCount, source: "overpass", updatedAt: new Date() },
      create: { name: row.name, lat: row.lat, lng: row.lng, zoneId: row.zoneId, wayCount: row.wayCount, source: "overpass" },
    })),
  ]);

  const counts = {};
  for (const z of cfg.zones) counts[z.id] = 0;
  for (const row of best.values()) counts[row.zoneId] = (counts[row.zoneId] || 0) + 1;
  const refreshedAt = new Date().toISOString();
  await prisma.$transaction([
    prisma.setting.upsert({ where: { key: "delivery.streetsRefreshedAt" }, update: { value: refreshedAt }, create: { key: "delivery.streetsRefreshedAt", value: refreshedAt } }),
    prisma.setting.upsert({ where: { key: "delivery.streetsCounts" }, update: { value: JSON.stringify(counts) }, create: { key: "delivery.streetsCounts", value: JSON.stringify(counts) } }),
    prisma.setting.upsert({ where: { key: "delivery.streetsLastError" }, update: { value: "" }, create: { key: "delivery.streetsLastError", value: "" } }),
  ]);
  return { ok: true, refreshedAt, counts, total: best.size, ways: elements.length, durationMs: Date.now() - started };
}

export { prisma as deliveryPrisma };
