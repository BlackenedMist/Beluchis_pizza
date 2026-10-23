# Beluchis — API Reference

Every HTTP endpoint served by the Express backend in `server/index.mjs`.

- **Base URL**: `http://localhost:<PORT>` — `PORT` from `.env`, default `3100`.
- **Format**: JSON request/response bodies (`Content-Type: application/json`). The PayFast and legacy PayGate callbacks are the exception (form-encoded).
- **Auth**: httpOnly, SameSite=Strict cookies set by login endpoints.
  - Staff: `beluchis_admin`
  - Customer portal: `beluchis_customer`
  - Sessions are in-memory, 12-hour TTL, reset on server restart.
- **Errors**: non-2xx responses return `{ "error": "human message" }`. Common statuses: `400` bad input, `401` not authenticated, `403` authenticated but insufficient role, `404` not found, `429` login throttled (10 attempts / 15 min per IP; loopback exempt), `502`/`503` payment-provider upstream/configuration failures.
- **Delivery block**: `POST /api/orders` returns `400` with `{ error, code: "delivery_out_of_range", distanceKm }` when the address is beyond the configured max radius.
- **Shop-closed block**: `POST /api/orders` returns `403` with `{ error, code: "shop_closed", openTime, closeTime, forceOpen }` when online ordering is off or the shop is outside its trading hours. Staff sessions bypass this check.

## Who is who

| Role | Login | Can do |
|------|-------|--------|
| **guest / public** | none | Browse menu, place orders, contact form, read delivery config |
| **customer** | cellphone + password (`/api/customer/auth/*`) | Own order history, own coupons |
| **kitchen** | staff username + PIN | View orders, advance `placed → … → delivered` (not cancel) |
| **cashier** | staff username + PIN | View orders, mark `out_for_delivery` only (no cancel / delivered) |
| **orders** | staff username + PIN | View orders, advance status, cancel, read/mark contact messages |
| **admin** | blank/`admin` + env `ADMIN_PIN` (default `1234`), or a staff user with role `admin` | Everything |

## Pages (non-API)

| Method | Path | Purpose |
|--------|------|---------|
| GET | `/` | Marketing homepage (`public/home.html`) |
| GET | `/order` | Storefront (`public/menu.html`) |
| GET | `/menu` | 301 → `/order` |
| GET | `/login` | Staff login (`public/login.html`) |
| GET | `/portal` | Customer portal (`public/customer.html`) |
| GET | `/preview` | 302 → `/preview/mobile` |
| GET | `/preview/mobile` | Storefront live simulator — iframe of `/order` in a phone/tablet/desktop device frame (`public/preview-mobile.html`) |
| GET | `/preview/portal` | Customer portal live preview — iframe of `/portal` that auto-signs-in as the seeded demo customer (`public/preview-portal.html`) |
| GET | `/admin` | Admin console (`public/admin.html`) |
| GET | `/cashier` | Cashier portal (`public/cashier.html`) — requires a staff session |
| GET | `/home/*` | Homepage static assets |

Static assets under `public/` are served automatically.

---

## 1. Public (no auth)

### Menu & catalog
| Endpoint | Purpose |
|----------|---------|
| `GET /api/categories` | All categories with item counts |
| `GET /api/items` | Menu items with sizes, toppings (+prices), bases (+prices), category |
| `GET /api/specials` | Bundle specials with their items |
| `GET /api/toppings` | All toppings with per-size prices |
| `GET /api/bases` | All bases with per-size prices |
| `GET /api/stats` | Row counts for all major tables |

> `GET /api/links` appears in older docs but is **not** registered — the storefront reads mappings via `GET /api/items`.

### Ordering
`POST /api/orders` — place an order. Validates items/sizes/toppings/bases/specials and **re-prices server-side** (any client price is ignored).

Body:
```jsonc
{
  "firstName": "Bongi",            // guest checkout, or omit with customerId
  "lastName": "Mbeki",
  "cellphone": "081 234 5678",     // guest checkout
  "email": "bongi@example.com",    // optional
  "items": [
    { "itemId": 151, "sizeLabel": "L", "quantity": 1,
      "extras": [{ "name": "Extra cheese", "price": 15 }] },   // menu line
    { "specialId": 3, "quantity": 1 },                          // flat/combo special line
    { "specialId": 9,                                           // BOGO line
      "pizzas": [
        { "itemId": 151, "sizeLabel": "M", "extras": [] },
        { "itemId": 160, "sizeLabel": "M", "extras": [{ "name": "Extra cheese", "price": 15 }] }
      ] }
  ],
  "deliveryAddress": "1 Long St, Worcester",
  "deliveryLat": -33.646, "deliveryLng": 19.448,   // legacy lat/lng also accepted
  "couponCode": "BELU-XXXX",
  "paymentMethod": "cod_cash",     // cod_cash | cod_card | payfast
  "notes": "Ring the side gate"
}
```

- A logged-in `beluchis_customer` session attaches the order to that account; otherwise guest lookup is by `cellphone` (or `email`), creating a `customer` row if new.
- `status` defaults to `placed` (also accept `preparing`/`out_for_delivery`/`delivered`/`cancelled`).
- Delivery: distance from the shop centre (Haversine). ≤ `freeRadiusKm` → `deliveryStatus: "free"` (fee 0); between radii → `"fee"` (fee added to `total`/`grandTotal`); > `maxRadiusKm` → `400 delivery_out_of_range`. Address without GPS → `"unverified"` (accepted, treated as collection); no address/coords → `"collection"`.
- Coupon validated server-side: active, unexpired, under usage limit, subtotal ≥ minSpend, customer-linked coupons need that customer logged in.
- `payfast` flow: the server signs the checkout fields and creates the order, then the response includes `redirect: { url, provider: "payfast", fields }` for the browser to auto-submit to PayFast. A fully-discounted order skips the gateway and is recorded as paid.
- **BOGO lines** (`special.kind === "bogo"`): send exactly one entry per pizza under `pizzas`, and the array length must equal the special's `count`. Every `itemId` must belong to the special's `categoryId` (and match `sizeLabel` when the special pins one). The server sorts base prices descending, charges only the higher half, and keeps extras payable. It writes one `OrderItem` per pizza and records the saving on `Order.discountAmount`. Invalid picks → `400`.
- **Automatic fixed-price deals** (`special.kind === "deal"`, e.g. *any 2 Large Traditional pizzas for R200*): these have **no line of their own** — the customer just adds the pizzas and the server prices them. Send the qualifying pizzas as ordinary `itemId` lines and never send the deal's `specialId`; doing so returns `400` (`… is an automatic deal - send its pizzas as normal item lines`).

  The server groups the ordered units by size, takes `floor(n / count)` groups cheapest-first, and charges `count ×` the deal's flat `price` per group. A group only earns the discount when it actually beats the normal base total, so two R90 Margheritas stay at R180 rather than being pushed **up** to R200. Extras never qualify and stay payable — the discount is computed on base price only, so the saving is clamped at 0 and can never make an order cost more. Overlapping deals can't discount the same pizza twice.

  The units keep their normal base price on their `OrderItem`s; the saving is folded into `Order.discountAmount` alongside any coupon, and named in `Order.discountLabel` (`"2 L Traditional Pizzas"`, or `"<deal> + <coupon>"` when both apply). `Order.total` stays the gross charged price, so `total - discountAmount = grandTotal` holds on every surface — receipt, cashier board, portal and confirmation email need no changes.
- Response `201`: the full order (`OrderItem`s, `customer`, `deliveryDistance`, `deliveryFee`, `deliveryStatus`, `total`, `discount*`, `grandTotal`), plus `redirect` for `payfast` orders that need payment.

### Contact
`POST /api/contact` — submit the homepage contact form.
Body: `{ name, message, email?, cellphone? }` (name + message required; email **or** cellphone required). → `201`.

### Delivery config
`GET /api/delivery/config` — the live delivery policy the storefront uses for hints:
```json
{ "enabled": true, "shop": { "lat": -33.646, "lng": 19.448 },
  "freeRadiusKm": 3, "maxRadiusKm": 10, "feeAmount": 30 }
```

### Shop status
`GET /api/shop/config` — trading hours + whether online ordering is accepted. The
storefront and homepage poll this on load.
```json
{ "openTime": "10:00", "closeTime": "21:00", "onlineEnabled": true,
  "forceOpen": false, "open": true }
```
- `open` is the resolved state for the shop's local time (SAST, UTC+2, no DST): `forceOpen` wins, otherwise `onlineEnabled` **and** now being within `openTime`–`closeTime`.
- Query `?at=ISO` previews the resolved state at an arbitrary timestamp (used by the admin schedule panel).
- Times are the setting strings; the client formats them. Values come from the `shop.*` settings below.

---

## 2. Staff & customer auth

| Endpoint | Auth | Purpose |
|----------|------|---------|
| `POST /api/auth/login` | public | `{ username?, pin }` — blank/`admin` username → env `ADMIN_PIN`. Sets `beluchis_admin` |
| `POST /api/auth/logout` | staff | Clears the staff session/cookie |
| `GET /api/auth/me` | staff | `{ principal, role, name }` |
| `POST /api/customer/auth/set-password` | public | Claim a guest account: `{ cellphone, password, firstName? }`. Password ≥ 4 chars; 404 if no order exists for that number; 400 if already claimed. Auto-login |
| `POST /api/customer/auth/login` | public | `{ cellphone, password }` — sets `beluchis_customer`. Rejects unclaimed accounts |
| `POST /api/customer/auth/logout` | customer | Clears customer session |
| `GET /api/customer/auth/me` | customer | Current customer profile (password hash never serialized) |

---

## 3. Orders (staff roles)

| Endpoint | Auth | Purpose |
|----------|------|---------|
| `GET /api/orders` | admin/orders/kitchen/cashier | All orders, newest first, with items + customer |
| `GET /api/orders/:id` | admin/orders/kitchen/cashier | Single order |
| `GET /api/customers/:id/orders` | admin/orders/kitchen/cashier | Orders for one customer |
| `PUT /api/orders/:id` | admin/orders+kitchen+cashier | `{ status }` flow transition |

`PUT /api/orders/:id` statuses: `placed → preparing → out_for_delivery → delivered`, or `cancelled`.
- `cancel` (or any status) is allowed for **admin/orders**.
- **kitchen** may only set `preparing` / `out_for_delivery` / `delivered` (403 otherwise).
- **cashier** may only set `out_for_delivery` (403 otherwise; no cancel, no delivered).
- A real transition appends an `OrderStatusEvent` (shown as a timeline to the customer).

---

## 4. Customer portal (customer own-data)

| Endpoint | Purpose |
|----------|---------|
| `GET /api/customer/orders` | Own order history, with items + status events; `grandTotal` resolved |
| `GET /api/customer/orders/:id` | Single own order (any other customer's id → 404) |
| `GET /api/customer/offers` | Active, unexpired, unused coupons issued to this customer |
| `GET /api/customer/favorites` | Own favourites — each row carries either the joined `item` (with `sizes` + `category`) or `special` (with `category`) |
| `POST /api/customer/favorites` | **Toggle** a favourite. Send exactly one of `itemId` / `specialId` (400 otherwise) → `{ "ok": true, "liked": true\|false }` |
| `DELETE /api/customer/favorites/:id` | Remove one favourite row (another customer's id → 404) |

Favourites are stored server-side (`Favorite`, unique per customer+item / customer+special) so
they follow the customer across devices. The storefront menu renders a ♥ toggle on every dish
and special; the portal lists them with an Order/View and Remove action.

---

## 5. Admin — menu, catalog, customers, users, loyalty, settings

Menu CRUD (`admin`). Writes are server-validated; `name` required; `400` on invalid payloads.

| Endpoint | Purpose |
|----------|---------|
| `POST /api/categories` / `PUT /api/categories/:id` / `DELETE /api/categories/:id` | Category CRUD |
| `POST /api/items` / `PUT /api/items/:id` / `DELETE /api/items/:id` | Items (sizes, `toppingIds`, `baseIds` swapped atomically on PUT). PUT accepts partial bodies, so `{ "showOnHome": true }` flags a tile without re-sending the item |
| `POST /api/toppings` / `PUT /api/toppings/:id` / `DELETE /api/toppings/:id` | Toppings + per-size prices; `isInSeason` (`bool`, default `true`) drives the storefront seasonal-swap rule |
| `POST /api/bases` / `PUT /api/bases/:id` / `DELETE /api/bases/:id` | Bases + per-size prices |
| `POST /api/specials` / `PUT /api/specials/:id` / `DELETE /api/specials/:id` | Specials. `kind: "flat"` (default) uses `price` + `items: [{ itemId, quantity, sizeLabel? }]` (a bundle pizza's `sizeLabel` must be a size that item sells); `kind: "bogo"` uses `categoryId`, `sizeLabel?` and an even `count ≥ 2`; `kind: "deal"` uses `categoryId`, `sizeLabel` and `count ≥ 2` plus a flat `price`. Both `bogo` and `deal` are priced per-order (see `POST /api/orders`) and `sizeLabel` must be a size the category actually sells |
| `POST /api/upload` | Upload an image. Body `{ dataUrl, filename? }` where `dataUrl` is a base64 `data:image/(png\|jpeg\|jpg\|gif\|webp);base64,…` (≤ 6 MB). Writes to `public/uploads/` → `{ "ok": true, "url": "/uploads/<name>" }` |

Customers (`admin`):
| Endpoint | Purpose |
|----------|---------|
| `GET /api/customers` | All customers with order counts |
| `POST /api/customers` | Create (`firstName`, `lastName`, `username`, `password`, `email?`, `cellphone?`, `lat/lng?`, `addressLabel?`) |
| `GET /api/customers/:id` | Customer with their orders |
| `PUT /api/customers/:id` | Update fields; `password` re-hashes if present |
| `DELETE /api/customers/:id` | Delete |

Staff users (`admin`):
| Endpoint | Purpose |
|----------|---------|
| `GET /api/users` | List staff users (no PIN hash exposed) |
| `POST /api/users` | Create `{ name, username, pin, role, isActive? }`; role ∈ `admin|orders|kitchen|cashier` |
| `PUT /api/users/:id` | Update `name`/`username`/`role`/`isActive` |
| `POST /api/users/:id/pin` | Reset PIN `{ pin }` (≥ 4 chars) |
| `DELETE /api/users/:id` | Delete |

Contact messages (`admin`+`orders` for reads):
| Endpoint | Auth | Purpose |
|----------|------|---------|
| `GET /api/contact` | admin/orders | All messages, newest first |
| `PUT /api/contact/:id` | admin/orders | `{ isRead }` |
| `DELETE /api/contact/:id` | admin | Delete |

Loyalty (`admin`):
| Endpoint | Purpose |
|----------|---------|
| `GET /api/loyalty/customers` | Spend report. Query: `q`, `tier`, `window` (`30|90|365|lifetime`, default 365), `minSpend`, `minOrders`. Returns `{ window, totals, tierBands, total, rows }` |
| `GET /api/loyalty/coupons` | Coupons; `?status=active|used|expired|all` |
| `POST /api/loyalty/coupons` | Create `{ customerId?, kind: percent|rand, value, label?, minSpend?, expiresAt?, note?, usageLimit? }`. Customer-linked → single-use. Returns a `BELU-XXXX` code |
| `PUT /api/loyalty/coupons/:id` | `{ isActive }` to deactivate/reactivate |

Delivery settings (`admin`):
| Endpoint | Purpose |
|----------|---------|
| `GET /api/settings` | All settings as `{ settings: { key: value } }` |
| `PUT /api/settings` | Upsert `{ settings: { "shop.lat": "-33.646", … } }`; validates ranges (400 on bad values). Returns settings + resolved delivery config |

Settings keys: `shop.lat`, `shop.lng`, `delivery.freeRadiusKm`, `delivery.maxRadiusKm`, `delivery.feeAmount`, `delivery.enabled` (`true|false`), `shop.openTime` (`HH:MM`), `shop.closeTime` (`HH:MM`), `shop.onlineEnabled` (`true|false`), `shop.forceOpen` (`true|false`). Constraints: lat ∈ [-90,90], lng ∈ [-180,180], radii > 0, maxRadius ≥ freeRadius, fee ≥ 0, times a valid 24-hour `HH:MM`.

`PUT /api/settings` also returns the resolved `shop` block from `GET /api/shop/config` so the admin UI can re-render the open/closed badge after a save.

---

## 6. PayFast online payments

| Endpoint | Caller | Purpose |
|----------|--------|---------|
| `POST /payfast/notify` | PayFast server | ITN (server-to-server). Verifies the signature, merchant ID, `amount_gross` and PayFast's `/eng/query/validate` response; updates the matched order (`paymentStatus paid/failed/pending`, txn fields) and replies `OK` (HTTP 200). Transient failures reply `500` so PayFast retries. |
| `POST/GET /payfast/return` | Customer browser | Redirect after payment. Looks up the order by `m_payment_id` (`Order.payRef`) and renders its stored status; applies the signed result if the redirect carries one. Pending orders show "being confirmed", not failed. |

Checkout is a form POST from the storefront to
`https://www.payfast.co.za/eng/process` (or `https://sandbox.payfast.co.za/eng/process`)
with these signed fields: `merchant_id`, `merchant_key`, `return_url`,
`cancel_url`, `notify_url`, `name_first`, `name_last`, `email_address`,
`m_payment_id`, `amount`, `item_name`, optional `payment_method`, and
`signature`.

Signature: URL-encode each value (space → `+`), join `key=value` pairs with `&`
in PayFast's documented order, append `&passphrase=<urlencoded passphrase>` if
one is configured, then MD5. The order reference (`BELU-XXXXXXXX`) is sent as
`m_payment_id`, which PayFast echoes back in the ITN. `payment_status` values:
`COMPLETE` → `paid`, `FAILED`/`CANCELLED` → `failed`, `PENDING` → stays
`pending`.

Configuration: `PAYFAST_ID`, `PAYFAST_KEY`, `PAYFAST_PASSPHRASE` (optional),
`PAYFAST_ENDPOINT` (default `https://www.payfast.co.za`),
`PAYFAST_PAYMENT_METHOD` (optional), and `PUBLIC_BASE_URL` (must be the public
HTTPS origin). PayFast must be able to reach `PUBLIC_BASE_URL/payfast/notify`
and the customer must be able to reach `PUBLIC_BASE_URL/payfast/return`.

PayGate (`/paygate/*`) is legacy: the routes remain so old `paygate` orders can
be reconciled, but the storefront no longer offers PayGate.