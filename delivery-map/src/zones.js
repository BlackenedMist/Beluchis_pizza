// Zone rendering + classification for the delivery map.
// All distances are in meters internally; config uses km.

export function kmToM(km) { return km * 1000; }

// Largest configured radius in km (outer zone with no max uses min + 5).
export function outerRadiusKm(zones) {
  return Math.max(...zones.map(z => (z.maxKm == null ? (z.minKm ?? 0) + 5 : z.maxKm)), 0);
}

// Square LatLngBounds around a centre covering the given radius in km.
export function boundsForRadiusKm(L, center, radiusKm) {
  const dLat = radiusKm / 111.32;
  const dLng = radiusKm / (111.32 * Math.cos(center.lat * Math.PI / 180));
  return new L.LatLngBounds(
    new L.LatLng(center.lat - dLat, center.lng - dLng),
    new L.LatLng(center.lat + dLat, center.lng + dLng)
  );
}

// Render stackable distance barriers as circles around the shop.
// `enabled` is an optional Set of zone ids; missing means all enabled.
/**
 * Draw zone circles (outline only) around the shop.
 * @param {object} map - Leaflet map.
 * @param {object} shopLatLng - Shop LatLng.
 * @param {Array<object>} zones - Zone definitions.
 * @param {object} L - Leaflet module.
 * @param {Set|string[]} [enabled] - Zone ids to render (default: all).
 * @returns {Array<{zone:object, layer:object}>}
 */
export function renderZones(map, shopLatLng, zones, L, enabled = null) {
  const layers = [];
  const active = enabled ? new Set(enabled) : new Set(zones.map(z => z.id));
  // Render largest first so smaller zones sit on top visually.
  const sorted = [...zones].sort((a, b) => (b.maxKm ?? b.minKm) - (a.maxKm ?? a.minKm));
  for (const z of sorted) {
    if (!active.has(z.id)) continue;
    const radius = kmToM(z.maxKm ?? z.minKm ?? 0);
    const circle = new L.Circle(shopLatLng, {
      radius,
      color: z.color,
      weight: 2,
      opacity: 0.9,
      fill: false,
      fillColor: z.fillColor || z.color,
      fillOpacity: 0,
    });
    circle.bindTooltip(z.label, { permanent: false, direction: 'center' });
    circle.addTo(map);
    layers.push({ zone: z, layer: circle });
  }
  return layers;
}

// Classify a point (LatLng) into a zone based on distance from shop.
// Chooses the innermost containing band.
/**
 * Classify a point into the innermost zone band containing it.
 * @param {object} shopLatLng - Shop LatLng.
 * @param {object} pointLatLng - Point LatLng.
 * @param {Array<object>} zones - Zone definitions.
 * @returns {{zone:object, distanceKm:number, distanceM:number}}
 */
export function classifyPoint(shopLatLng, pointLatLng, zones) {
  const distanceM = shopLatLng.distanceTo(pointLatLng);
  const distanceKm = distanceM / 1000;
  const candidates = zones.filter(z => {
    const min = z.minKm;
    const max = z.maxKm == null ? Infinity : z.maxKm;
    return distanceKm >= min && distanceKm < max;
  });
  if (candidates.length === 0) {
    // beyond all defined bands -> outermost
    const outer = zones.reduce((a, b) => ((a.minKm) > (b.minKm) ? a : b), zones[0]);
    return { zone: outer, distanceKm, distanceM };
  }
  // innermost = smallest maxKm
  const inner = candidates.reduce((a, b) => {
    const am = a.maxKm == null ? Infinity : a.maxKm;
    const bm = b.maxKm == null ? Infinity : b.maxKm;
    return am <= bm ? a : b;
  }, candidates[0]);
  return { zone: inner, distanceKm, distanceM };
}
