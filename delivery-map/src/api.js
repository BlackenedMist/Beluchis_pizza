import { classifyPoint } from './zones.js';

// Simulated server: checks a point against the zones config and returns
// delivery eligibility. Replace the body with a real fetch to your backend.
export function createApi(config) {
  const shop = config.shop;
  const zones = config.zones;
  const shopLatLng = { lat: shop.lat, lng: shop.lng, distanceTo(o){ /* filled below */ } };

  // We need a real LatLng-like object; callers pass Leaflet LatLng. Here we
  // provide a helper that accepts {lat,lng} and uses haversine.
  function haversine(a, b) {
    const R = 6371000;
    const toRad = x => x * Math.PI / 180;
    const dLat = toRad(b.lat - a.lat);
    const dLng = toRad(b.lng - a.lng);
    const s = Math.sin(dLat/2)**2 + Math.cos(toRad(a.lat))*Math.cos(toRad(b.lat))*Math.sin(dLng/2)**2;
    return 2 * R * Math.asin(Math.sqrt(s));
  }

  return {
    /**
     * Check a coordinate against delivery zones (no-delivery first, then innermost).
     * @param {number} lat
     * @param {number} lng
     * @returns {Promise<{inArea:boolean, distanceKm:number, fee:(number|null), currency:string, zoneId:(string|null), label:string, message:string}>}
     */
    async checkDelivery(lat, lng) {
      const point = { lat, lng };
      const shopPt = { lat: shop.lat, lng: shop.lng };
      const distanceM = haversine(shopPt, point);
      const distanceKm = distanceM / 1000;
      // No-delivery zones take priority
      const noneZones = zones.filter(z => z.type === 'none' || z.fee === null);
      const noneMatch = noneZones.find(z => {
        const min = z.minKm ?? 0;
        const max = z.maxKm == null ? Infinity : z.maxKm;
        return distanceKm >= min && distanceKm < max;
      });
      if (noneMatch) {
        return { inArea: false, distanceKm: Number(distanceKm.toFixed(2)), fee: null, currency: config.currency || 'ZAR', zoneId: noneMatch.id, label: noneMatch.label || noneMatch.name, message: 'No delivery available' };
      }
      const candidates = zones.filter(z => {
        if (z.type === 'none' || z.fee === null) return false;
        const min = z.minKm ?? 0;
        const max = z.maxKm == null ? Infinity : z.maxKm;
        return distanceKm >= min && distanceKm < max;
      });
      const zone = candidates.length
        ? candidates.reduce((a, b) => {
            const am = a.maxKm == null ? Infinity : a.maxKm;
            const bm = b.maxKm == null ? Infinity : b.maxKm;
            return am <= bm ? a : b;
          }, candidates[0])
        : null;

      if (!zone) {
        return { inArea: false, distanceKm: Number(distanceKm.toFixed(2)), fee: null, currency: config.currency || 'ZAR', zoneId: null, label: 'Outside delivery area', message: 'You are outside the delivery area' };
      }
      const eligible = zone.fee !== null;
      return {
        inArea: eligible,
        distanceKm: Number(distanceKm.toFixed(2)),
        fee: zone.fee,
        currency: config.currency || 'ZAR',
        zoneId: zone.id,
        label: zone.label || zone.name,
        message: eligible
          ? (zone.fee === 0 ? 'Free delivery' : `Delivery fee R${zone.fee}`)
          : 'You are outside the delivery area',
      };
    },
    haversine,
  };
}
