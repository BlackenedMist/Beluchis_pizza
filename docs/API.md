# Beluchis — API Reference

Every HTTP endpoint served by the Express backend in `server/index.mjs`.

- **Base URL**: `http://localhost:<PORT>` — `PORT` from `.env`, default `3100`.
- **Format**: JSON request/response bodies (`Content-Type: application/json`). The PayGate callbacks are the exception (form-encoded).
- **Auth**: httpOnly, SameSite=Strict cookies set by login endpoints.
  - Staff: `beluchis_admin`
  - Customer portal: `beluchis_customer`
  - Sessions are in-memory, 12-hour TTL, reset on server restart.
- **Errors**: non-2xx responses return `{ "error": "human message" }`. Common statuses: `400` bad input, `401` not authenticated, `403` authenticated but insufficient role, `404` not found, `429` login throttled (10 attempts / 15 min per IP; loopback exempt), `503`/`502` PayGate-upstream failures.
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
    { "specialId": 9,                                           // BOGO deal line
      "pizzas": [
        { "itemId": 151, "sizeLabel": "M", "extras": [] },
        { "itemId": 160, "sizeLabel": "M", "extras": [{ "name": "Extra cheese", "price": 15 }] }
      ] }
  ],
  "deliveryAddress": "1 Long St, Worcester",
  "deliveryLat": -33.646, "deliveryLng": 19.448,   // legacy lat/lng also accepted
  "couponCode": "BELU-XXXX",
  "paymentMethod": "cod_cash",     // cod_cash | cod_card | paygate
  "notes": "Ring the side gate"
}
```

- A logged-in `beluchis_customer` session attaches the order to that account; otherwise guest lookup is by `cellphone` (or `email`), creating a `customer` row if new.
- `status` defaults to `placed` (also accept `preparing`/`out_for_delivery`/`delivered`/`cancelled`).
- Delivery: distance from the shop centre (Haversine). ≤ `freeRadiusKm` → `deliveryStatus: "free"` (fee 0); between radii → `"fee"` (fee added to `total`/`grandTotal`); > `maxRadiusKm` → `400 delivery_out_of_range`. Address without GPS → `"unverified"` (accepted, treated as collection); no address/coords → `"collection"`.
- Coupon validated server-side: active, unexpired, under usage limit, subtotal ≥ minSpend, customer-linked coupons need that customer logged in.
- `paygate` flow: first initiates PayWeb3; on success the response includes `redirect: { url, fields }` for the browser to auto-submit. Orders never persisted upstream of a gateway failure.
- **BOGO lines** (`special.kind === "bogo"`): send exactly one entry per pizza under `pizzas`, and the array length must equal the special's `count`. Every `itemId` must belong to the special's `categoryId` (and match `sizeLabel` when the special pins one). The server sorts base prices descending, charges only the higher half, and keeps extras payable. It writes one `OrderItem` per pizza and records the saving on `Order.discountAmount`. Invalid picks → `400`.
- Response `201`: the full order (`OrderItem`s, `customer`, `deliveryDistance`, `deliveryFee`, `deliveryStatus`, `total`, `discount*`, `grandTotal`).

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
| `POST /api/specials` / `PUT /api/specials/:id` / `DELETE /api/specials/:id` | Specials. `kind: "flat"` (default) uses `price` + `itemIds`; `kind: "bogo"` uses `categoryId`, `sizeLabel?` and an even `count ≥ 2` and is priced per-order (see `POST /api/orders`) |
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

## 6. PayGate (PayWeb3 online payments)

| Endpoint | Caller | Purpose |
|----------|--------|---------|
| `POST /paygate/notify` | PayGate server | Server-to-server result post; verifies checksum, updates the matched order (`paymentStatus paid/failed`, txn fields), replies bare `OK` |
| `POST /paygate/return` | PayGate | Browser redirect after payment; verifies checksum, records result, renders a receipt-style page |

Matches orders by the `REFERENCE` (stored as `Order.payRef`, `BELU-…` generated at order time).