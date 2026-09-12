# Beluchis Menu & Order — DB + Admin App

A single lightweight Express + Prisma (SQLite) application for Beluchis pizza: a
customer menu/order storefront, a PIN-login admin console with a live staff
Orders board, role-based access, and full menu/data administration.

## Quick start (preview/publish on a Linux box)

```bash
# 1. Unzip the package (includes a pre-seeded database + node_modules for linux-x64)
unzip beluchis-preview-*.zip -d beluchis
cd beluchis

# 2. Finish setup (no-op if node_modules is already extracted)
./install.sh

# 3. Run
./start.sh
```

The server prints its URLs on boot:

- **Marketing homepage**: http://localhost:3100/
  (hero, signature dishes, Napoletana banner, contact form)
- **Storefront (Menu & Order)**: http://localhost:3100/order
- **Customer portal (My Orders)**: http://localhost:3100/portal
- **Admin console**: http://localhost:3100/admin
- **Log**: `tail -f /tmp/beluchis.log`

### Logging in

- **Admin**: leave username blank **or** type `admin`, and enter the PIN from
  `.env` (`ADMIN_PIN`, default `1234`). This is the env-PIN login.
- **Staff**: any username + PIN created under the **Users** tab in the admin
  console (roles: `admin`, `orders`, `kitchen`).
- **Customer**: open `/portal` (or "My orders" in the storefront header). First
  time you must claim your account — place an order with your cellphone, then
  "First time? Set your password". After that, log in with cellphone + password
  to view your order history (with a live status timeline) and any coupons
  issued to you ("Offers for you"). Never re-enter a password if it was set
  before. Guest checkout accounts are auto-created; claiming attaches past and
  future orders to your login.

### From source (this repo)

```bash
npm install          # run install first (its postinstall runs prisma generate)
cp .env.example .env # or edit your .env
npm run migrate      # apply migrations to a fresh dev.db
npm run seed         # load the demo catalog (idempotent)
./start.sh
```

## Configuration (`.env`)

| Key          | Default | Purpose                                        |
|--------------|---------|------------------------------------------------|
| `DATABASE_URL` | `file:../dev.db` | SQLite database file (relative to `prisma/`) |
| `PORT`       | `3100`  | HTTP listen port                               |
| `ADMIN_PIN`  | `1234`  | Env-PIN for the built-in admin login           |
| `PAYGATE_ID` | _(empty)_ | PayGate PayWeb3 merchant id (online payments)  |
| `PAYGATE_KEY`| _(empty)_ | PayGate PayWeb3 checksum secret                 |
| `PUBLIC_BASE_URL` | `http://localhost:<PORT>` | Public origin PayGate redirects your browser to (`/paygate/return`) and posts results to (`/paygate/notify`) |

`ADMIN_PIN` only works for the built-in admin login (blank username or
`admin`). Staff users each carry their own PIN (bcrypt-hashed in the DB).

### Payments

- **Cash on delivery** (`cod_cash`) and **card on delivery** (`cod_card`) are
  always available. The admin Orders board shows the chosen method as a badge
  (`Cash on delivery` / `Card on delivery`) for staff, display-only.
- **Online via PayGate** (`paygate`) is offered at checkout only when both
  `PAYGATE_ID` and `PAYGATE_KEY` are set. On submit the server initiates a
  PayWeb3 transaction **before** the order is written (a failed gateway call
  leaves no orphan order) and responds with a hidden-form redirect to
  `secure.paygate.co.za`; the storefront auto-submits it and the customer is
  taken to PayGate to pay.
- PayWeb3 flow: `POST /payweb3/initiate.trans` → order created + redirect →
  PayGate posts the outcome to `POST /paygate/notify` (replies bare `OK`) and
  redirects the browser to `/paygate/return`, where the response checksum is
  verified server-side (canonical PayGate field order) before the order is
  marked `paid` / `failed` and the txn fields stored.
- `TRANSACTION_STATUS=1` (approx "Auth Done") → order `paymentStatus=paid`;
  anything else → `failed`; checksum mismatch → ignored, order stays `pending`.
- Test mode: use sandbox credentials from PayGate's test portal. On a local
  machine `/paygate/notify` is **not** reachable by PayGate's servers, so the
  status is taken from the `/paygate/return` browser POST. The shipped
  `PAYGATE_KEY=secret` sandbox utilities are widely documented; the sandbox
  may block some networks at the CDN level (preview shipped with local-path
  verification + documentation).
- An order paid online shows `Online (PayGate) · paid|failed|pending` on the
  admin board. Zero-rand orders (e.g. coupon covers the total) skip the gateway
  and are recorded as already paid.

## Components

| Path | What |
|------|------|
| `public/home.html` | Marketing homepage. Served at `/`. Hero + signature-dish gallery (each tile deep-links into the order page), Napoletana banner, contact form (`POST /api/contact`). No external credit text. |
| `public/menu.html` | Customer storefront — menu by category, specials, pizza customization (bases/toppings by size), quantity steppers on items/specials/in the customize dialog, cart (reconciled against the live menu on load so stale item/special ids are pruned), checkout & place order (optional coupon-code field + payment method: cash or card on delivery, or online PayGate when enabled; PayGate orders auto-redirect to the secure portal). Served at `/order`. Supports deep links: `?item=<slug>` (flashes the item + opens its customize dialog) and `?cat=<slug>` (scrolls to the category). After an order it stores `beluchis-recent-order` in localStorage and links to `/portal`. |
| `public/customer.html` | Customer portal — logged-out login / "First time? Set your password" forms; logged-in dashboard with order history (expandable rows showing items + a full status timeline from `OrderStatusEvent`s) and "Offers for you" coupon cards (Copy code). Served at `/portal`, authed by the `beluchis_customer` cookie. |
| `public/login.html` | Staff login (username + PIN). Served at `/login`. |
| `public/admin.html` | Admin console. Served at `/admin`. Tabs: **Orders** (live board), **Inbox** (contact form messages, admin/orders), **Items**, **Specials**, **Toppings**, **Bases**, **Categories**, **Users**, **Loyalty** (admin-only). |
| `public/theme.css` | Shared design tokens (colors, type, spacing). |
| `server/index.mjs` | Express app — static files, REST API, auth/RBAC, session handling, brute-force throttling. |
| `prisma/schema.prisma` | SQLite data model. |
| `prisma/seed.ts` | Idempotent demo catalog (items, categories, toppings, bases, specials, customers/orders, 2 specials). |
| `scripts/extract-catalog.mjs` | Re-imports a menu catalog from `catalog/*.json` (extracted from the WordPress backup). |
| `start.sh` / `stop.sh` | Start (detached, writes `.beluchis.pid`, health-checks `/api/stats`) and stop. |

## Roles & permissions

| Capability | admin | orders | kitchen | guest |
|------------|:-----:|:------:|:-------:|:-----:|
| Place an order (storefront) | — | — | — | ✅ |
| View orders board | ✅ | ✅ | ✅ | |
| Advance order status placed→preparing→out_for_delivery→delivered | ✅ | ✅ | ✅ | |
| Cancel an order | ✅ | ✅ | | |
| Menu CRUD (items, specials, toppings, bases, categories) | ✅ | | | |
| Users / staff management | ✅ | | | |
| Customers view | ✅ | | (orders view) | |
| Loyalty (spend table, issue/deactivate coupons) | ✅ | | | |
| View own orders + coupons (customer portal) | | | | ✅ (own only) |
| Place an order | | | | ✅ |

### Loyalty

- **Score** = customer spend in a window ÷ total non-cancelled sales in that
  window × 100 (e.g. total sales R10 000, customer R6 000 → 60%).
- **Tier** (from the 365-day score): `platinum ≥30%`, `gold ≥20%`,
  `silver ≥10%`, `bronze ≥5%`, else `none`.
- Spend is measured on the payable amount (`grandTotal`, falling back to
  `total` for legacy rows); cancelled orders are excluded.
- Admin **Loyalty** tab: search/filter (name/phone/email, tier, window 30/90/365
  days/lifetime, min spend, min orders), a per-customer **Issue** button, and an
  issued-coupons list. Issuing produces a `BELU-XXXX` code you can Copy, send
  via a pre-filled WhatsApp (`wa.me`) link, or send by email.
- Coupons are `percent` or fixed-`rand`, optionally with a min spend + expiry.
  A customer-linked coupon is single-use and shows under that customer's
  "Offers for you"; a blank-customer ("public") coupon is a shareable code.
- Redemption is validated **server-side** (never client-trusted): active, not
  expired, under usage limit, subtotal ≥ min spend, and — if customer-linked —
  only usable by that logged-in customer. Discount: percent → `round(subtotal×v/100)`;
  rand → `min(v, subtotal)`; `grandTotal = subtotal − discount`.

Delivery radius (added day 6):

- **Storefront**: the checkout delivery-address field shows a live hint — free
  delivery inside the free radius, the flat fee + estimated km between radii, or
  an out-of-range warning that blocks the order. If the browser shares location
  (> 8s timeout), the estimate uses GPS; otherwise it falls back to plain
  address mode. Address without GPS is accepted as "unverified" (treated as
  collection), never blocked.
- **Server**: `POST /api/orders` takes `deliveryLat`/`deliveryLng` (legacy
  `lat`/`lng` also accepted) and runs Haversine against the shop centre.
  ≤ `freeRadiusKm` → `free` (no fee); between radii → `fee` (added to `total`);
  beyond `maxRadiusKm` → HTTP 400 `{ code: "delivery_out_of_range", distanceKm }`.
  Address without GPS → `unverified`; no address/coords → `collection`.
- **Admin Delivery tab (admin-only)**: toggle delivery on/off, shop centre
  lat/lng (default Worcester CBD `-33.646, 19.448`), free radius (default 3 km),
  max radius (default 10 km), flat fee between radii (default R30). Settings are
  stored in a `Setting` key/value table; invalid values are rejected with 400.
  Orders with a delivery status show a Free-delivery / fee / unverified badge.

Order statuses: `placed`, `preparing`, `out_for_delivery`, `delivered`, `cancelled`.
Status changes append an `OrderStatusEvent` (shown as a timeline to the customer).
Role-gating in the UI matches the server (`requireRole`); storefront ordering is public.

## API overview

Auth:

- `POST /api/auth/login` — `{ username?, pin }`; blank or `admin` username → env PIN. Brute-force throttled per IP (10 attempts / 15 min; loopback exempt).
- `POST /api/auth/logout`
- `GET /api/auth/me` — `{ principal, role, name }`

Menu & admin:

- `GET /api/stats` — counts for items, toppings, bases, categories, links, customers, orders, orderItems, specials, contact, coupons, orderStatusEvents.
- `POST /api/contact` — public; contact form from the homepage (`{ name, message, email?, cellphone? }`).
- `GET /api/contact` (admin/orders), `PUT /api/contact/:id` (`{ isRead }`, admin/orders), `DELETE /api/contact/:id` (admin).
- `GET/POST/api/items|specials|toppings|bases|categories` and `PUT/DELETE /api/.../:id` (admin-only mutations).
- `GET /api/customers` (admin), `GET /api/links` (public), `GET /api/orders` (logged-in orders/kitchen/admin).
- `GET /api/delivery/config` — public; the delivery policy the storefront uses for hints.
- `GET /api/settings` (admin) and `PUT /api/settings` (admin) — read/upsert the `Setting` table (delivery radius policy); `PUT` validates ranges and returns both settings and the resolved delivery config.
- `POST /api/orders` — public; validates items/sizes/toppings/bases/specials and re-prices server-side. Optional `couponCode` validated + applied server-side; `paymentMethod` (`cod_cash` default | `cod_card` | `paygate`) chosen at checkout; a logged-in customer session attaches the order to their account. Optional `deliveryLat`/`deliveryLng` (legacy `lat`/`lng`) plus `deliveryAddress` drive the delivery-radius policy above — `deliveryDistance`, `deliveryFee` and `deliveryStatus` are stored on the order. For `paygate` it first initiates the PayWeb3 transaction and responds with `{ order, redirect: { url, fields } }` for the storefront to auto-submit.
- `POST /paygate/notify` — PayGate server-to-server result post; replies bare `OK`.
- `POST/GET /paygate/return` — PayGate browser redirect after payment; verifies the response checksum and records `paid` / `failed` on the matched order (by `REFERENCE`/`payRef`), then renders a receipt-style result page.
- `PUT /api/orders/:id` — `{ status }` flow transition or `cancel`; cancel restricted to admin/orders. Status changes append an `OrderStatusEvent`.
- `/api/users` CRUD + `POST /api/users/:id/reset-pin` (admin-only). `pinHash` never serialized.

Customer portal (authed by `beluchis_customer` cookie):

- `POST /api/customer/auth/set-password` — claim a guest account by cellphone (+ optional first name) and set a password; auto-login. Rejects if the account is already claimed.
- `POST /api/customer/auth/login` / `logout` / `GET me` — cellphone + password (rejects unclaimed accounts), brute-force throttled per IP.
- `GET /api/customer/orders` and `GET /api/customer/orders/:id` — the customer's own orders (with items + status `events`); foreign ids return 404.
- `GET /api/customer/offers` — active, unexpired, unused coupons issued to the customer.

Loyalty (admin-only):

- `GET /api/loyalty/customers` — params `q`, `tier`, `window` (`30|90|365|lifetime`), `minSpend`, `minOrders`; returns per-customer spend + loyalty score% for each window, tier, and the window's total-sales denominator.
- `POST /api/loyalty/coupons` — create a coupon (`{ customerId?, kind, value, label?, minSpend?, expiresAt?, note? }`); customer-linked → single use.
- `GET /api/loyalty/coupons?status=active|used|expired|all`.
- `PUT /api/loyalty/coupons/:id` — `{ isActive }` to deactivate/reactivate.

Sessions are in-memory (12h TTL, `SameSite=Strict` cookie `beluchis_admin`; customer sessions use `beluchis_customer`) and reset on restart — acceptable for single-box preview.

## Data model

`Category`, `Item`, `ItemSize`, `Topping`, `ToppingPrice`, `Base`, `BasePrice`,
`ItemTopping`, `ItemBase`, `Special`, `SpecialItem`, `Customer`, `Order`,
`OrderItem`, `OrderStatusEvent`, `Coupon`, `StaffUser`, `ContactMessage`,
`Setting`. See
`prisma/schema.prisma` for
relations. Menu migrations used: `init`, `add_customers_orders`, `add_specials`,
`add_staff_users`, `add_contact_messages`, `add_customer_portal_loyalty`,
`add_order_payment`, `add_delivery_settings`. `Order` carries
`paymentMethod`/`paymentStatus` and the
PayGate fields `payRef`, `payRequestId`, `txnId`, `resultCode`, `resultDesc`,
plus the delivery fields `deliveryLat`, `deliveryLng`, `deliveryAddress`,
`deliveryDistance`, `deliveryFee`, `deliveryStatus`. `Setting` holds the
delivery radius policy (`shop.lat`, `shop.lng`, `delivery.freeRadiusKm`,
`delivery.maxRadiusKm`, `delivery.feeAmount`, `delivery.enabled`), seeded
with Worcester-CBD defaults and recreated by the seeder (upsert preserves admin
edits on re-seed).

## Notes / known issues

- Customer & staff sessions are in-memory and reset on restart. Existing staff
  users keep working; customer passwords (`Customer.passwordHash`) persist in
  the DB across restarts.
- Cellphone login/set-password matches the **exact** phone string the customer
  used at checkout (the same trim that `POST /api/orders` stores), so use the
  exact same format (e.g. `081 234 5678` vs `+27 81 234 5678` must match).

- Re-seeding grows SQLite autoincrement IDs every run — never hardcode IDs in
  scripts; fetch them via the API.
- `npm audit` reports 6 advisories (pre-existing). Prisma 7 deprecation
  warnings for `package.json#prisma`.
- The `catalog/` directory is generated output (gitignored) — it is included in
  the preview zip so `npm run setup` works anywhere.
- `sqlite3` CLI is not installed; manage the DB via Prisma / the API.
- The shipped preview `node_modules` is built for **linux-x64**. On other
  platforms remove it and run `npm install` (postinstall regenerates the Prisma
  client + engines).

## Next steps (ideas)

- Prod deployment (real `ADMIN_PIN`, HTTPS/domain, session store backend).
- POS/order printer + customer order lookup.
- Reporting (sales by hour/day, best sellers) in the Orders tab.