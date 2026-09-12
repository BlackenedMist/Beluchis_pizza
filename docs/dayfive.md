# dayfive.md — Beluchis Customer Portal + Loyalty & Coupons (Day 5)

Date: 2026-09-08

## Summary

Day 5 gave Beluchis two new customer-facing capabilities on top of the Day 4
build:

1. **Customer portal** at `/portal` — "My orders" for shoppers. A customer
   claims their guest account (cellphone + password at checkout), then logs in
   to see their order history with a live status timeline and any coupons
   issued to them ("Offers for you").
2. **Loyalty & coupons** — a new admin **Loyalty** tab that turns order spend
   into customer tiers (bronze/silver/gold/platinum), lets staff issue coupon
   codes (shareable via Copy / WhatsApp / email), and a checkout `couponCode`
   field that applies the discount server-side.

## What was built

### Routing (server/index.mjs)
- `/portal` → `public/customer.html` (customer portal).
- Order status board advances are unchanged, but every status change now also
  appends an `OrderStatusEvent` (`{ orderId, status, note }`) so the customer
  portal can render a timeline.
- `PUT /api/orders/:id` returns the order via a new `withGrandTotal()` helper
  (`grandTotal ?? total` for legacy rows where `grandTotal` is null).

### Customer portal (`public/customer.html`)
- Logged-out view: **Log in** (cellphone + password) and **First time? Set your
  password** (claim a guest account by cellphone; rejects already-claimed).
- Logged-in view: welcome bar + "Order now" / "Log out"; **Order history** —
  expandable order cards showing items, amounts (incl. discount/grandTotal) and
  a full status timeline; **Offers for you** — active, unexpired, unused coupons
  with a Copy-code button.
- Authed by the `beluchis_customer` cookie (in-memory session, 12h TTL);
  cellphone matching is exact-string (same trim that checkout stores).

### Loyalty (server + admin)
- `TIER_BANDS`: platinum ≥30%, gold ≥20%, silver ≥10%, bronze ≥5% of 12-month
  sales. Score = customer spend in a window ÷ total non-cancelled sales in that
  window × 100. Spend measured on `grandTotal`/`total`; cancelled excluded.
- `GET /api/loyalty/customers` — one row per customer with per-window spend +
  score (30/90/365 days/lifetime), tier, orders count, last order; filters
  `q`, `tier`, `window`, `minSpend`, `minOrders`.
- `POST /api/loyalty/coupons` (create; customer-linked → single-use),
  `GET /api/loyalty/coupons?status=active|used|expired|all`,
  `PUT /api/loyalty/coupons/:id` (deactivate/reactivate).
- Coupons are `percent` or fixed `rand`, optional `minSpend`/`expiresAt`/`note`;
  codes are `BELU-` + 4 hex bytes. Redemption is validated server-side in
  `POST /api/orders` (active, unexpired, under usage limit, subtotal ≥ minSpend,
  owner when customer-linked); discount percent → `round(subtotal×v/100)`,
  rand → `min(v, subtotal)`, `grandTotal = subtotal − discount`.
- `public/admin.html` **Loyalty** tab (admin-only): search/filter bar (name,
  tier, window, min spend, min orders), spend table with tier badges + last
  order + "Issue" button, issued-coupons list (status filter + deactivate),
  and an issue-coupon modal with Copy / WhatsApp (`wa.me/27...`) / email send.

### Storefront (`public/menu.html`) + homepage (`public/home.html`)
- Coupon-code input in the checkout form; success box shows discount +
  grandTotal, stores `beluchis-recent-order` in localStorage, links to `/portal`.
- Header "My orders" + footer link to `/portal` (menu + homepage).

### DB
- `prisma/schema.prisma` + migration `20260908184959_add_customer_portal_loyalty`:
  `OrderStatusEvent`, `Coupon`, and `Customer` gains `passwordHash`, `claimedAt`,
  `lastLoginAt`. `Order` gains `grandTotal Int?` (null = legacy = total).

## Files changed

- `db_data/server/index.mjs` — `/portal`, customer-auth + orders + offers APIs,
  loyalty APIs, coupon redemption in `POST /api/orders`, `OrderStatusEvent`
  writes, `withGrandTotal`, stats now reports `coupons` + `orderStatusEvents`.
- `db_data/public/customer.html` — **new** customer portal (login/set-password,
  order history + timeline, offers).
- `db_data/public/admin.html` — **Loyalty** tab: filters, spend table, issue
  coupon modal, coupons list + deactivate.
- `db_data/public/menu.html` — coupon field + payload, portal links,
  discount/grandTotal in the success box, `beluchis-recent-order`.
- `db_data/public/home.html` — header nav + footer "MY ORDERS" → `/portal`.
- `db_data/prisma/schema.prisma` + `db_data/prisma/migrations/20260908184959_add_customer_portal_loyalty/`.
- `db_data/README.md` — routes, components, roles, loyalty explanation, API,
  data model updated.

## Verification (all passed)

- `node --check` on `server/index.mjs`; migration applied cleanly; booted on
  `:3407`.
- API flow (curl script):
  - `/`, `/order`, `/portal` → 200; admin login (`beluchis_admin` cookie)
    works; 401 without sessions.
  - Guest places order → guest `Customer` auto-created (unique per cellphone);
    `set-password` claims it; login OK; wrong password 401; unknown cellphone
    login 401; re-claim already-claimed returns 400.
  - `GET /api/customer/orders` shows the placed order with a `placed` event
    timeline; `GET /api/customer/orders/:id` 404s for another customer's order.
  - Admin issues a 20%-off coupon to the customer → it appears in
    `GET /api/customer/offers`; checkout redeems it (R120 order → R24 off →
    `grandTotal` 96); reusing the code is rejected; offers list empties; coupon
    shows `status=used`.
  - `PUT /api/orders/:id` status → `preparing` appends an event; timeline
    `['placed','preparing']`.
  - `minSpend` filter respected; loyalty as a customer → 401.
- Headless Chrome (CDP via `google-chrome --headless=new`):
  - `/portal` logged-out renders login + set-password forms.
  - Admin `/admin` with an admin cookie: clicking the **Loyalty** tab shows the
    spend table (customers, tier badges, "Issue new coupon").
  - `/portal` logged-in (customer cookie): welcome name, 1 order card with a 4-step
    timeline + `PLACED` badge; offers panel hidden when no coupons.

## Run

- Live: `http://localhost:3100/portal` (customer portal — "My orders"),
  `http://localhost:3100/order` (storefront), `http://localhost:3100/admin`
  (admin + **Loyalty** tab, PIN `1234`). Log `/tmp/beluchis.log`.

## Notes / known issues

- Sessions remain in-memory (reset on restart) — customer passwords persist in
  the DB, but an active customer/staff login needs to be re-established after a
  restart. Accepted for preview.
- Cellphone login/set-password is exact-string matching on the phone as typed
  at checkout (e.g. `081 234 5678` vs `+27 81 234 5678` must match).
- Re-seeding grows SQLite autoincrement IDs — never hardcode IDs.
- Shipped `node_modules` is linux-x64; other platforms `rm -rf node_modules &&
  npm install` (postinstall regenerates the Prisma client).

## Deliverable

`README.md` + a rebuilt preview zip `beluchis-preview-2026-09-08.zip`
(unzip → `./install.sh` → `./start.sh`). The user will add the remaining
social-media tags on top of this build.