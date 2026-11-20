# Delivery map module

Reusable Leaflet module used by the main app for delivery zones, OSM street
names and the friendly customer address wizard. The running app only loads
the built files in `public/assets/`; this folder holds the source.

## Build

```bash
npm run build:delivery-map
```

Writes `public/assets/beluchis-delivery.js`, `Control.Geocoder.js` and
`Control.Geocoder.css`. The bundle uses the global `L` (Leaflet 1.9.4) already
loaded by the pages and exposes `window.BeluchisDelivery` with
`createAddressWizard()` and `createMasterMap()`. It bundles no Leaflet copy.

## Source

| File | Purpose |
|---|---|
| `src/addressWizard.js` | 3-step customer wizard: find address → confirm pin → done. Large type, big buttons, plain wording. |
| `src/geocode/deliveryGeocoder.js` | FreeOSM adapter (Photon suggestions + Nominatim lookup), biased to the shop and filtered by `POST /api/delivery/check`. Also offers server-curated streets first. |
| `src/masterMap.js` | Admin map: shop pin, zone circles, per-zone street counts, OSM refresh button. |
| `src/zones.js`, `src/api.js`, `src/config.js` | Zone drawing/classification and local demo fallbacks. |
| `src/integration.js` | Bundle entry point. |

## Where it is used

- `public/admin.html` → Deliveries tab (`createMasterMap`)
- `public/menu.html` → checkout "Find my address" (`createAddressWizard`)
- `public/customer.html` → saved locations "Find my address"

All three pass `L` explicitly and use `/api/delivery/zones`,
`/api/delivery/streets` and `/api/delivery/check` so the wizard and real order
pricing share one source of truth.

## Street data

`POST /api/delivery/streets/refresh` (admin) or `npm run streets:refresh`
fetches named streets from Overpass with a 150 s timeout and multiple endpoints,
stores one representative point per street per zone in `DeliveryStreet`, and
records counts in `Setting` keys `delivery.streets*`.

## ⚠️ Production migration note

When migrating to production, **change the values from the old map ranges to
the new zones deliberately**:

1. Back up the live `dev.db`.
2. Compare the live `delivery.freeRadiusKm`, `delivery.maxRadiusKm`,
   `delivery.feeAmount`, `delivery.beyondFeeAmount` with the intended zone
   bands (old ranges may differ from the new 3 km / 10 km / R30 / R95 demo).
3. Set `delivery.noDeliveryRadiusKm` explicitly — leave **blank** to keep the
   current "deliver everywhere at the beyond fee" behaviour, or set a value
   to activate the red no-delivery zone.
4. Run the street refresh on production and confirm **green and yellow**
   delivery zones both have non-zero street counts before enabling the wizard.
5. Smoke-test one address in each band and compare the wizard's fee with the
   real order total. Fee changes must never happen silently at deploy time.
