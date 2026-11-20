import { boundsForRadiusKm, outerRadiusKm } from '../zones.js';

/**
 * A geocoder for the delivery wizard.
 *
 * It uses the free OpenStreetMap-backed providers shipped with
 * leaflet-control-geocoder (Photon while typing, Nominatim on Enter), biases
 * every query to the shop's delivery area, and throws away any result that is
 * outside the delivery zones. What comes back is a normal GeocodingResult, so
 * the control's existing suggestion/keyboard/accessibility code works as-is.
 */
export function createDeliveryGeocoder({ L, api, config, geocoders, streetEntries = [] }) {
  const shop = new L.LatLng(config.shop.lat, config.shop.lng);
  const bounds = boundsForRadiusKm(L, shop, outerRadiusKm(config.zones));
  const viewbox = [bounds.getWest(), bounds.getSouth(), bounds.getEast(), bounds.getNorth()]
    .map((n) => Number(n.toFixed(5)))
    .join(',');

  // Photon supports live suggestions; Nominatim forbids them, so it is only
  // used for an explicit "find this address" search.
  const photon = new geocoders.Photon({
    geocodingQueryParams: { bbox: viewbox, lat: config.shop.lat, lon: config.shop.lng },
  });
  const nominatim = new geocoders.Nominatim({
    geocodingQueryParams: { countrycodes: 'za', bounded: 1, viewbox },
  });

  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));

  function addressParts(raw, source) {
    const p = raw.properties || {};
    if (source === 'nominatim') {
      const a = p.address || {};
      return {
        number: a.house_number || '',
        street: a.road || a.pedestrian || a.footway || '',
        area: a.suburb || a.city_district || a.city || a.town || a.village || a.hamlet || '',
        region: a.state || a.region || '',
        postcode: a.postcode || '',
      };
    }
    return {
      number: p.housenumber || p.house_number || '',
      street: p.street || p.name || p.road || '',
      area: p.suburb || p.city || p.town || p.village || p.district || '',
      region: p.state || '',
      postcode: p.postcode || '',
    };
  }

  async function finalize(raw, source) {
    if (!raw || !raw.center) return null;
    const check = await api.checkDelivery(raw.center.lat, raw.center.lng);
    // Only addresses we can actually deliver to reach the user.
    if (!check.inArea) return null;

    const parts = addressParts(raw, source);
    const label = [parts.number, parts.street].filter(Boolean).join(' ') || raw.name || 'Selected location';
    const contextLine = [parts.area, parts.region].filter(Boolean).join(', ');
    return {
      ...raw,
      name: label,
      html:
        '<div class="aw-result-main">' + esc(label) + '</div>' +
        '<div class="aw-result-sub">' +
          esc([contextLine, check.label].filter(Boolean).join(' · ')) +
        '</div>',
      properties: { ...p_or_empty(raw.properties), source, delivery: check, address: parts },
    };
  }

  function p_or_empty(p) {
    return p && typeof p === 'object' ? p : {};
  }

  // Streets curated in the admin Master map are offered first — they are
  // guaranteed to be inside the delivery bands and work even if OSM is down.
  async function localResult(entry) {
    const center = new L.LatLng(entry.lat, entry.lng);
    const check = await api.checkDelivery(entry.lat, entry.lng);
    if (!check.inArea) return null;
    return {
      name: entry.name,
      center,
      bbox: new L.LatLngBounds(center, center),
      html: '<div class="aw-result-main">' + esc(entry.name) + '</div>' +
        '<div class="aw-result-sub">' + esc(check.label || check.message || '') + '</div>',
      properties: {
        source: 'local',
        address: { number: '', street: entry.name, area: '', zoneId: entry.zoneId },
        delivery: check,
      },
    };
  }

  function dedupeSource(entries) {
    const seen = new Set();
    return entries.filter(({ r }) => {
      if (!r || !r.center) return false;
      const key = [r.center.lat.toFixed(4), r.center.lng.toFixed(4)].join(',');
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  }

  return {
    /** As-you-type suggestions: Photon only, zone-filtered, nearest first. */
    async suggest(query, context) {
      const q = String(query || '').toLowerCase().trim();
      const local = await Promise.all(
        streetEntries.filter((e) => e.name && e.name.toLowerCase().includes(q)).map(localResult)
      );
      let raws = [];
      try {
        raws = await photon.suggest(query, context);
      } catch (_) {}
      const remote = await Promise.all(raws.map((r) => finalize(r, 'photon')));
      const seen = new Set();
      return [...local, ...remote]
        .filter(Boolean)
        .sort((a, b) => a.center.distanceTo(shop) - b.center.distanceTo(shop))
        // One entry per street: identical-looking choices confuse people.
        .filter((r) => {
          const key = r.name.toLowerCase();
          if (seen.has(key)) return false;
          seen.add(key);
          return true;
        });
    },

    /** Explicit search: Nominatim first (house numbers), Photon as backup. */
    async geocode(query, context) {
      let raws = [];
      try {
        raws = (await nominatim.geocode(query, context)).map((r) => ({ r, source: 'nominatim' }));
      } catch (_) {}
      if (raws.length < 3) {
        try {
          const extra = (await photon.geocode(query, context)).map((r) => ({ r, source: 'photon' }));
          raws = dedupeSource([...raws, ...extra]);
        } catch (_) {}
      }
      const q = String(query || '').toLowerCase().trim();
      const local = await Promise.all(
        streetEntries.filter((e) => e.name && e.name.toLowerCase().includes(q)).map(localResult)
      );
      const out = await Promise.all(raws.map(({ r, source }) => finalize(r, source)));
      return [...local, ...out].filter(Boolean).sort((a, b) => {
        const da = a.center.distanceTo(shop);
        const db = b.center.distanceTo(shop);
        return da - db;
      });
    },

    /** Reverse lookup used for the area label; needs no zone filtering. */
    reverse(location, scale) {
      return photon.reverse(location, scale);
    },
  };
}
