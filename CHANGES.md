# Beluchis Pizza — Site Audit & Hardening

Date: 2026-11-12

## Security / correctness fixes

- **Order extras are validated**: negative or absurd extra prices are rejected (`400`), closing a hole where a crafted cart line could make an order total negative and an online order auto-mark itself paid.
- **`POST /api/orders` no longer trusts client `customerId` or `status`**: public storefront requests always start `placed`; only a staff session may attach an arbitrary customer or choose a starting status. Closes cross-account order writes and guest status spoofing.
- **Guest order responses are redacted**: a matched account's profile (email, pins, address) is no longer echoed back to whoever typed the phone number.
- **Guest duplicate-order check no longer leaks order details**: `GET /api/customer/active-orders?phone=` returns only `hasActive`/`count` for guests.
- **Password claim/reset require the account's first name** (it was optional). This is still not a second factor — see the audit notes — but it removes the no-verification takeover path.
- **Legacy phone formats**: login/claim/reset/order lookup now tolerates formatted numbers (`+27 82 …`) and prefers a claimed account; `findCustomerByPhone` falls back to normalised matching. Admin create/update and customer profile save canonicalise.
- **`scripts/normalize-customer-phones.mjs`** (dry-run by default, `--apply` to write) reports and normalises legacy rows.
- **Production has no default admin PIN**: without `ADMIN_PIN`, the env-PIN login returns `503` instead of accepting `1234`.
- **Revoked sessions**: password set/reset invalidates the customer's other portal sessions; deactivating/deleting/resetting a staff PIN invalidates their staff sessions; deleting a customer invalidates their session.
- **`/home`** now serves the homepage (the static image directory used to redirect it to a 404).
- **HTTP hardening**: `X-Content-Type-Options`, `X-Frame-Options`, `Referrer-Policy`; global JSON body limit cut to 256 KB with a 10 MB limit only on `/api/upload` (a 6 MB image previously risked 413); unexpected 500s no longer return raw Prisma messages.

## Storefront / order-flow fixes

- Payable totals now use `grandTotal` everywhere (cashier, driver, admin order cards/history); a delivery tip without a discount previously showed the pre-tip total.
- The order-success screen, driver board and active-order warning use the daily order number (`dailyNumber`) consistently.
- Admin order-history and cashier date filters use `dayKey` (SAST) instead of the UTC date.
- BOGO/bundle cart lines are keyed by size, pizzas and extras, so two variants of the same deal no longer merge into one wrong-priced line.
- Single-pizza automatic deals (`count: 1` — Super Sunday / Weekday) now preview in the cart; the client previously ignored them until checkout.
- Pasta types are reconciled/re-priced on cart load and reorder; a deleted type no longer charges the customer.
- Removed the unused `/api/toppings` request from the storefront load.
- Special banners honour an uploaded image; only image-less specials rotate through item photos.
- Receipts and confirmation emails itemise the driver tip.

## Tests / docs

- `scripts/storefront-smoke.mjs` and `scripts/test-poller-cadence.mjs` were pointing at the removed `/api/shop/config`; they now use `/api/shop/status`, and the BOGO modal assertion matches the current tile picker. The full storefront smoke suite passes.
- README/docs no longer reference the unregistered `/api/links` or the old shop-config path.
- README notes the `total - discount + tip = grandTotal` invariant.

## Still recommended (not changed here)

- Replace the phone + first-name password reset with an emailed one-time link/OTP (or staff-issued reset). The current flow is weaker than production auth should be.
- Add rate limiting to public order creation and the contact form.
- Re-price topping/base extras server-side (they are validated to be non-negative but still client-priced), and clean up stale/deleted extras during reconciliation.
- Add `Secure` to session cookies behind HTTPS, and a persistent session store if the app is ever scaled beyond one instance.
- Add a couple of API regression tests for the order-pricing rules (negative extras, collection-only, forged status/customerId).
- Compress API responses and add cache headers for menu images (`/api/items` is ~600 KB uncompressed).

---

# Beluchis Pizza — Specials Builder, Collection-Only Offers & Home Copy

Date: 2026-11-12

## Summary

- Admin **Specials** now uses plain-language offer presets (buy X get Y free, any N for a set price, combo, reduced item, build-your-own bundle) with a live tile/banner preview.
- Per-special **Collection only** flag: the offer advertises with a badge, but delivery customers cannot add it and it is enforced server-side.
- Owner-authored home copy (`homeHeadline`, `homeSubtext`, `homeBadge`, `homePriceText`) with correct auto-generated fallbacks.
- Home and order pages share one formatter (`public/special-display.js`) so copy never drifts between them ("Buy 3, get 1 free" instead of "Pick N, pay N/2" or `R0`).
- Specials without an uploaded picture auto-rotate through the pictures of the dishes inside the offer.
- Menu page: a sticky row of category shortcut chips (Deals, Pizzas, Pastas, Desserts, …) smooth-scrolls to each section and highlights the current one.
- Admin **Pasta Types** (modelled on pizza Bases): per-size extra charges, assign-to-all-pastas, per-item assignment, and a storefront pasta-type picker; the server re-prices the choice and records it as a `Pasta: <type>` extra on the order.

## Data

- Migration `20261112120000_add_special_collection_and_home_copy`: adds `Special.collectionOnly`, `homeHeadline`, `homeSubtext`, `homeBadge`, `homePriceText`.
- Migration `20261112150000_add_pasta_types`: adds `PastaType`, `PastaTypePrice` and `ItemPastaType`.

## Server (`server/index.mjs`)

- `POST/PUT /api/specials` accept the new fields (trimmed + length-capped).
- Fixed the category `pick` path, which incorrectly validated as a priced deal and rejected `buy 3, get 1 free`.
- `POST /api/orders` returns `400 special_collection_only` for delivery orders containing a collection-only special (quotes included); automatic collection-only deals are skipped on delivery.
- Fixed the undefined `tipAmount` in the order quote/create path; delivery tips now add to `grandTotal`.

## Storefront (`public/home.html`, `public/menu.html`, `public/shop.js`)

- Shared `SpecialDisplay` text + image helpers.
- Home tiles/banners show headline, supporting line, promo badge, collection badge; order cards mirror it.
- Order page: collection-only offers are disabled once Delivery is selected, and checkout is blocked until the line is removed or Collection is chosen.
- Cart lines record `collectionOnly` and the correct `payCount`.

## Docs

- `README.md`, `docs/API.md` and `public/admin-guide.html` (EN + AF) updated.

---

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
