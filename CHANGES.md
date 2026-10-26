# Beluchis Pizza — Order Flow & Delivery Locations Changes

Date: 2026-10-26

## Summary

Reworked the customer delivery experience so that:

- Each customer can save up to **3 uniquely-named delivery locations**, each with a map pin.
- Checkout **only** allows delivery to a saved location (no free-text / GPS-on-load).
- An address created during checkout is saved and becomes the delivery address for that order.
- The Collection/Delivery toggle hides/shows a single map (no duplicate maps, no auto-GPS).
- A **Review & Confirm** step shows a two-pin map (shop + delivery), the delivery fee, and the grand total before the order is queued or paid.
- The "Buy 2 Traditional pizzas" deal applies multiple times and is clearly itemised.
- Item prices synced to the live site (beluchis.co.za).
- Deals carousel shows a single tile on small screens.

## Server (`server/index.mjs`)

### Address CRUD (`/api/customer/addresses`)
- `POST`: 3-slot cap (`address_limit`), case-insensitive unique label (`duplicate_label`), required map pin (`pin_required`), max 30-char label, auto-default first row.
- `PUT`: same validation; unsetting the only default keeps it default.
- `DELETE`: promotes the oldest remaining row to default.
- `GET`: returns `{ items, limit, used }`.

### Orders (`/api/orders`)
- Accepts `deliveryAddressId`; signed-in delivery must reference an owned saved location (`saved_location_required`); `deliveryAddress`/`lat`/`lng` derived server-side from that row so the fee uses the saved pin.
- Guests remain collection-only.
- Removed the legacy `Customer.addressLabel/lat/lng` mirror write.
- Added `quote: true` for a price-only quote (no order/customer/coupon side effects) returning lines, totals, delivery fee/distance, address, and a `discounts` array (one entry per deal application).

## Portal (`public/customer.html`)

- Removed the duplicate "Delivery address + map" block from My details (name/phone/email only now).
- Single map in "Delivery locations": click/drag pin, optional explicit "Use my current location" (never auto-GPS), edit-in-place, set-default, delete, counter "n of 3", disabled add at cap, "Pin needed" flag for legacy rows.

## Checkout (`public/menu.html`)

- Single `#delivery-map` shown only when adding a location; saved-location `<select>` + resolved address text; "Add a new location" saves via the API and selects it.
- Collection hides the whole delivery block and preserves the selection; delivery restores it.
- Guests: delivery disabled, block hidden.
- Submit calls the quote endpoint and opens a **Review & Confirm** step: two-pin map, line items, discounts (with `3 x ...` aggregation), subtotal, discount, delivery fee, grand total, payment method.
- Back / Cancel buttons on the review page (robust across `innerHTML` swaps).
- Deals carousel: single tile on ≤640px screens, two on larger, re-init on resize.

## Data

- Migration `20261026180000_backfill_customer_addresses`: backfills one "Home" location per customer with a legacy address and no saved rows.
- `scripts/normalize-customer-addresses.mjs`: dry-run by default; dedupes exact duplicates, renames same-name/different-address rows, archives over-limit rows with JSON backup, ensures one default.
- Seed updated with 1–3 uniquely named locations per demo customer.
- Item prices synced to live site (beluchis.co.za).

## Docs

- `README.md` and `docs/API.md` updated (address endpoints, `deliveryAddressId`, `quote`, legacy profile fields).
