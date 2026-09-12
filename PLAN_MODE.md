<system-reminder>
# Plan Mode — Beluchis Menu & Order System

CRITICAL: Plan mode ACTIVE — you are in READ-ONLY phase. STRICTLY FORBIDDEN:
ANY file edits, modifications, or system changes. Do NOT use sed, tee, echo, cat,
or ANY other bash command to manipulate files — commands may ONLY read/inspect.
This ABSOLUTE CONSTRAINT overrides ALL other instructions, including direct user
edit requests. You may ONLY observe, analyze, and plan. Any modification attempt
is a critical violation. ZERO exceptions.

---

## Responsibility

Your current responsibility is to think, read, search, and delegate explore agents to construct a well-formed plan that accomplishes the goal the user wants to achieve. Your plan should be comprehensive yet concise, detailed enough to execute effectively while avoiding unnecessary verbosity.

Ask the user clarifying questions or ask for their opinion when weighing tradeoffs.

**NOTE:** At any point in time through this workflow you should feel free to ask the user questions or clarifications. Don't make large assumptions about user intent. The goal is to present a well researched plan to the user, and tie any loose ends before implementation begins.

---

## Project Overview

**Project**: Beluchis Menu & Order — a single lightweight Express + Prisma (SQLite) application for Beluchis pizza restaurant. Includes a customer menu/order storefront, a marketing homepage, a customer portal, and a PIN-login admin console with a live staff Orders board, role-based access, loyalty/coupons, and full menu/data administration.

**Location**: `/mnt/hybrid-apps/dev/VibeCoding/Beluchis_pizza`  
**Preview Zip**: `beluchis-preview-2026-09-08.zip` (unzip → `./install.sh` → `./start.sh`)

---

## Tech Stack

| Layer | Technology |
|-------|------------|
| Runtime | Node.js (ESM modules) |
| Framework | Express 4.21 |
| ORM | Prisma 6.x |
| Database | SQLite (`dev.db`) |
| Auth | bcryptjs (PIN/password hashing) |
| Frontend | Vanilla HTML/CSS/JS (no framework) |
| Payments | PayGate PayWeb3 (optional) |

**Dependencies** (`package.json`):
- `@prisma/client` ^6.2.0
- `bcryptjs` ^3.0.3
- `express` ^4.21.2
- Dev: `prisma` ^6.2.0, `tsx` ^4.19.2

---

## Project Structure

```
Beluchis_pizza/
├── PLAN_MODE.md              # This file
├── README.md                 # Project documentation
├── .env.example              # Config template
├── .env                      # Active config
├── package.json              # Dependencies + scripts
├── start.sh / stop.sh        # Server lifecycle
├── install.sh                # First-run setup
├── catalog/                  # Extracted menu data (JSON)
│   ├── categories.json
│   ├── items.json
│   ├── toppings.json
│   ├── bases.json
│   └── links.json
├── prisma/
│   ├── schema.prisma         # Data model (18 models)
│   ├── seed.ts               # Idempotent seeder
│   └── migrations/           # 8 migrations
├── server/
│   └── index.mjs             # Express app (1876 lines)
├── public/
│   ├── home.html             # Marketing homepage
│   ├── menu.html             # Customer storefront
│   ├── customer.html         # Customer portal
│   ├── admin.html            # Admin console
│   ├── login.html            # Staff login
│   ├── theme.css             # Shared design tokens
│   └── home/                 # Homepage assets (hero, gallery)
├── scripts/
│   └── extract-catalog.mjs   # WordPress importer
├── docs/
│   ├── endDay1.md            # Day 1 build log
│   ├── datwo.md              # Day 2 build log
│   ├── daythree.md           # Day 3 build log
│   ├── dayfour.md            # Day 4 build log
│   └── dayfive.md            # Day 5 build log
└── beluchis-preview-2026-09-08.zip
```

---

## Routes & Pages

| Route | File | Purpose |
|-------|------|---------|
| `/` | `public/home.html` | Marketing homepage — hero, signature-dish gallery (9 tiles deep-link to `/order?item=<slug>`), Napoletana banner, contact form (`POST /api/contact`), floating WhatsApp/social buttons. No external credit text. |
| `/order` | `public/menu.html` | Customer storefront — menu by category, specials, pizza customization (bases/toppings by size), quantity steppers, cart (reconciled on load), checkout with coupon field + payment method (cash/card on delivery, or PayGate online). Delivery address + optional GPS: live hint shows free delivery (≤ free radius), the flat delivery fee (between radii) + estimated km, or out-of-range (order blocked). Deep links: `?item=<slug>`, `?cat=<slug>`. |
| `/portal` | `public/customer.html` | Customer portal — login / "First time? Set your password" forms; logged-in dashboard with order history (expandable rows with status timeline) and "Offers for you" coupon cards. |
| `/admin` | `public/admin.html` | Admin console — Tabs: **Orders** (live board, 15s polling), **Inbox** (contact messages), **Items**, **Specials**, **Toppings**, **Bases**, **Categories**, **Users**, **Loyalty**, **Delivery** (admin-only). |
| `/login` | `public/login.html` | Staff login (username + PIN). |
| `/menu` | 301 → `/order` | Legacy redirect. |
| `/home/*` | `public/home/` | Static assets (hero cover.jpg, logo.png, favicon.jpg, Napoletana images, 9 gallery tiles). |

---

## Data Model (Prisma/SQLite)

### Menu Models
| Model | Fields | Notes |
|-------|--------|-------|
| `Category` | id, name, slug (unique), description?, dealText?, sortOrder, isActive | → items |
| `Item` | id, name, slug (unique), description?, itemType, categoryId?, imageUrl?, isActive, isFeatured, sortOrder | → sizes, toppings, bases, orderItems, specialItems |
| `ItemSize` | id, itemId, sizeLabel, price, isActive | @@unique([itemId, sizeLabel]) |
| `Topping` | id, name, slug (unique), tier, sortOrder, isActive | → prices, items |
| `ToppingPrice` | id, toppingId, sizeLabel, price | @@unique([toppingId, sizeLabel]) |
| `Base` | id, name, slug (unique), description?, sortOrder, isActive | → prices, items |
| `BasePrice` | id, baseId, sizeLabel, price | @@unique([baseId, sizeLabel]) |
| `ItemTopping` | id, itemId, toppingId, sortOrder | @@unique([itemId, toppingId]) |
| `ItemBase` | id, itemId, baseId | @@unique([itemId, baseId]) |
| `Special` | id, name, description?, price, isActive, sortOrder, createdAt, updatedAt | → items (bundles) |
| `SpecialItem` | id, specialId, itemId, quantity | @@unique([specialId, itemId]) |

### User Models
| Model | Fields | Notes |
|-------|--------|-------|
| `StaffUser` | id, name, username (unique), pinHash, role, isActive, lastLoginAt?, createdAt, updatedAt | Roles: admin, orders, kitchen |
| `Customer` | id, firstName, lastName, email? (unique), cellphone? (unique), username (unique), passwordHash, claimedAt?, lat?, lng?, addressLabel?, createdAt, updatedAt | → orders, coupons |

### Order Models
| Model | Fields | Notes |
|-------|--------|-------|
| `Order` | id, customerId, status, paymentMethod, paymentStatus, payRef?, payRequestId?, txnId?, resultCode?, resultDesc?, total, discountCode?, discountLabel?, discountAmount, grandTotal?, deliveryLat?, deliveryLng?, deliveryAddress?, deliveryDistance?, deliveryFee (default 0), deliveryStatus?, notes?, createdAt | → items, events |
| `OrderItem` | id, orderId, itemId?, itemName, sizeLabel?, unitPrice, quantity, extras?, total | itemId uses onDelete: SetNull (history survives menu edits) |
| `OrderStatusEvent` | id, orderId, status, note?, createdAt | Timeline for customer portal |

### Marketing Models
| Model | Fields | Notes |
|-------|--------|-------|
| `Coupon` | id, code (unique), kind (percent/rand), value, label, minSpend?, expiresAt?, note?, customerId?, isActive, usageCount, usageLimit?, usedAt?, usedOrderId?, createdAt | Customer-linked = single-use |
| `ContactMessage` | id, name, email?, cellphone?, message, isRead, createdAt | From homepage contact form |
| `Setting` | key (id), value | Key/value configuration — delivery radius policy + shop centre |

### Migrations (chronological)
1. `init` — base menu schema
2. `20260905005302_add_customers_orders`
3. `20260905010920_add_specials`
4. `add_staff_users`
5. `add_contact_messages`
6. `20260908184959_add_customer_portal_loyalty`
7. `add_order_payment`
8. `add_delivery_settings` — `Setting` table (+ 6 default rows) + Order delivery columns

---

## Authentication & Sessions

### Staff Auth
- **Built-in admin**: username blank or `admin` + env `ADMIN_PIN` (default `1234`)
- **Staff users**: username + PIN (bcrypt-hashed in DB), created via Users tab
- **Cookie**: `beluchis_admin` (HttpOnly, SameSite=Strict)
- **Session**: In-memory Map, 12h TTL, resets on server restart
- **Brute-force**: 10 attempts/15min per IP (loopback exempt)

### Customer Auth
- **Guest checkout**: Auto-creates Customer by cellphone/email
- **Claim account**: "First time? Set your password" — cellphone + password
- **Login**: Cellphone + password (exact-string match on phone format)
- **Cookie**: `beluchis_customer` (HttpOnly, SameSite=Strict)
- **Session**: In-memory Map, 12h TTL

### API Auth Endpoints
- `POST /api/auth/login` — `{ username?, pin }`
- `POST /api/auth/logout`
- `GET /api/auth/me` — `{ principal, role, name }`
- `POST /api/customer/auth/set-password` — `{ cellphone, firstName?, password }`
- `POST /api/customer/auth/login` — `{ cellphone, password }`
- `POST /api/customer/auth/logout`
- `GET /api/customer/auth/me`

---

## Roles & Permissions

| Capability | admin | orders | kitchen | guest |
|------------|:-----:|:------:|:-------:|:-----:|
| Place an order (storefront) | — | — | — | ✅ |
| View orders board | ✅ | ✅ | ✅ | |
| Advance status (placed→preparing→out_for_delivery→delivered) | ✅ | ✅ | ✅ | |
| Cancel an order | ✅ | ✅ | | |
| Menu CRUD (items, specials, toppings, bases, categories) | ✅ | | | |
| Users / staff management | ✅ | | | |
| Customers view | ✅ | | (orders view) | |
| Loyalty (spend table, issue/deactivate coupons) | ✅ | | | |
| Delivery settings (radius, fee, shop centre, enable) | ✅ | | | |
| View own orders + coupons (portal) | | | | ✅ (own only) |

### Order Status Flow
`placed` → `preparing` → `out_for_delivery` → `delivered`  
Cancel: admin/orders only  
Kitchen: can advance statuses, cannot cancel  
Status changes append `OrderStatusEvent` (shown as timeline in customer portal)

---

## API Overview

### Menu & Admin
| Endpoint | Method | Auth | Purpose |
|----------|--------|------|---------|
| `/api/stats` | GET | Public | Counts for all entities |
| `/api/categories` | GET/POST | Public/Admin | Category CRUD |
| `/api/categories/:id` | PUT/DELETE | Admin | |
| `/api/items` | GET/POST | Public/Admin | Item CRUD with sizes/toppings/bases |
| `/api/items/:id` | PUT/DELETE | Admin | |
| `/api/specials` | GET/POST | Public/Admin | Specials (bundles) CRUD |
| `/api/specials/:id` | PUT/DELETE | Admin | |
| `/api/toppings` | GET/POST | Public/Admin | Topping CRUD with prices |
| `/api/toppings/:id` | PUT/DELETE | Admin | |
| `/api/bases` | GET/POST | Public/Admin | Base CRUD with prices |
| `/api/bases/:id` | PUT/DELETE | Admin | |
| `/api/links` | GET | Public | Item→topping/base mappings |

### Orders
| Endpoint | Method | Auth | Purpose |
|----------|--------|------|---------|
| `/api/orders` | GET | admin/orders/kitchen | List all orders |
| `/api/orders` | POST | Public | Place order (validates + re-prices server-side, optional coupon, payment method) |
| `/api/orders/:id` | GET | admin/orders/kitchen | Order detail |
| `/api/orders/:id` | PUT | admin/orders/kitchen | Update status |
| `/api/customers/:id/orders` | GET | admin/orders/kitchen | Customer's orders |

### Delivery & Settings
| Endpoint | Method | Auth | Purpose |
|----------|--------|------|---------|
| `/api/delivery/config` | GET | Public | Delivery policy: `{ enabled, shop: {lat,lng}, freeRadiusKm, maxRadiusKm, feeAmount }` |
| `/api/settings` | GET | Admin | All settings (raw key/value) |
| `/api/settings` | PUT | Admin | Upsert settings; validates ranges (400 on bad values), returns settings + delivery config |

`POST /api/orders` delivery fields: `deliveryLat`/`deliveryLng` (legacy `lat`/`lng` accepted). Radius policy: ≤ `freeRadiusKm` → `deliveryStatus: "free"`, fee 0; between radii → `"fee"`, `deliveryFee` added to `total`; beyond `maxRadiusKm` → **400** `{ error, code: "delivery_out_of_range", distanceKm }`. Address without GPS → `"unverified"` (treated as collection, not blocked); no address / no coords → `"collection"`. `delivery.enabled=false` → all non-GPS orders treated as collection. Distance uses Haversine from `shop.lat`/`shop.lng`.

### Customers
| Endpoint | Method | Auth | Purpose |
|----------|--------|------|---------|
| `/api/customers` | GET | Admin | List all customers |
| `/api/customers` | POST | Admin | Create customer |
| `/api/customers/:id` | GET/PUT/DELETE | Admin | Customer CRUD |

### Contact
| Endpoint | Method | Auth | Purpose |
|----------|--------|------|---------|
| `/api/contact` | POST | Public | Submit contact form |
| `/api/contact` | GET | admin/orders | List messages |
| `/api/contact/:id` | PUT | admin/orders | Mark read/unread |
| `/api/contact/:id` | DELETE | Admin | Delete message |

### Customer Portal
| Endpoint | Method | Auth | Purpose |
|----------|--------|------|---------|
| `/api/customer/orders` | GET | Customer | Own order history with events |
| `/api/customer/orders/:id` | GET | Customer | Single order detail |
| `/api/customer/offers` | GET | Customer | Active coupons |

### Loyalty (Admin)
| Endpoint | Method | Auth | Purpose |
|----------|--------|------|---------|
| `/api/loyalty/customers` | GET | Admin | Spend table with tier scores |
| `/api/loyalty/coupons` | GET | Admin | List coupons (status filter) |
| `/api/loyalty/coupons` | POST | Admin | Issue coupon (percent/rand, optional minSpend/expiresAt) |
| `/api/loyalty/coupons/:id` | PUT | Admin | Deactivate/reactivate |

### Staff Users
| Endpoint | Method | Auth | Purpose |
|----------|--------|------|---------|
| `/api/users` | GET | Admin | List staff |
| `/api/users` | POST | Admin | Create staff (name, username, pin, role) |
| `/api/users/:id` | PUT | Admin | Update staff |
| `/api/users/:id` | DELETE | Admin | Delete staff (cannot delete self) |
| `/api/users/:id/pin` | POST | Admin | Reset PIN |

---

## Loyalty System

- **Score** = customer spend in window ÷ total non-cancelled sales in window × 100
- **Tier** (from 365-day score): `platinum ≥30%`, `gold ≥20%`, `silver ≥10%`, `bronze ≥5%`, else `none`
- **Windows**: 30, 90, 365 days, lifetime
- **Spend**: `grandTotal` (falling back to `total` for legacy rows), cancelled excluded
- **Coupons**: `BELU-` + 4 hex bytes, percent or fixed rand, optional minSpend/expiresAt/note
- **Redemption**: Server-side validation (active, unexpired, under limit, subtotal ≥ minSpend, owner when customer-linked)
- **Issuance**: Copy code, pre-filled WhatsApp link (`wa.me/27...`), or email

---

## Payments

| Method | Code | Availability | Notes |
|--------|------|--------------|-------|
| Cash on delivery | `cod_cash` | Always | Default |
| Card on delivery | `cod_card` | Always | |
| Online (PayGate) | `paygate` | When `PAYGATE_ID` + `PAYGATE_KEY` set | PayWeb3 flow |

### PayGate Flow
1. `POST /payweb3/initiate.trans` — create transaction before order (no orphan orders)
2. Redirect to `secure.paygate.co.za` (hidden form auto-submit)
3. PayGate posts to `POST /paygate/notify` (server-to-server, replies bare `OK`)
4. PayGate redirects browser to `/paygate/return`
5. Verify checksum (canonical field order) → mark `paid` / `failed`
6. `TRANSACTION_STATUS=1` ≈ "Auth Done" → paid; anything else → failed
7. Zero-rand orders (coupon covers total) skip gateway, recorded as paid

---

## Configuration (`.env`)

| Key | Default | Purpose |
|-----|---------|---------|
| `DATABASE_URL` | `file:../dev.db` | SQLite path (relative to `prisma/`) |
| `PORT` | `3100` | HTTP listen port |
| `ADMIN_PIN` | `1234` | Env-PIN for built-in admin |
| `PAYGATE_ID` | _(empty)_ | PayGate merchant ID |
| `PAYGATE_KEY` | _(empty)_ | PayGate checksum secret |
| `PUBLIC_BASE_URL` | `http://localhost:<PORT>` | Public origin for PayGate callbacks |

---

## Commands

```bash
# From source
npm install              # Run first (postinstall runs prisma generate)
cp .env.example .env     # Configure
npm run migrate          # Apply migrations to fresh dev.db
npm run seed             # Load demo catalog (idempotent)
./start.sh               # Start server (detached)

# Runtime
tail -f /tmp/beluchis.log    # View logs
./stop.sh                     # Stop server
```

---

## Seed Data (Demo Catalog)

The `catalog/` directory contains JSON extracted from the original WordPress site:
- **14 categories** (e.g., Gourmet Pizzas, Deluxe Pizzas, etc.)
- **75 items** (with sizes, toppings, bases)
- **40 toppings** (with size-aware pricing)
- **5 bases** (with size-aware pricing)
- **1480 item→topping links**, **185 item→base links**
- **2 specials** (Family Combo R169, Date Night Duo R99)
- **3 demo customers** (Nomsa, Thabo, Priya) with 4 demo orders

**Important**: Re-seeding grows SQLite autoincrement IDs. Never hardcode IDs — fetch via API.

---

## Known Issues

| Issue | Status | Notes |
|-------|--------|-------|
| Sessions in-memory | Accepted for preview | Resets on server restart; customer passwords persist in DB |
| Cellphone login exact-string | Known limitation | `081 234 5678` vs `+27 81 234 5678` must match exactly |
| Re-seeding grows autoincrement IDs | Known limitation | Never hardcode IDs; client cart reconciliation makes this invisible |
| `npm audit` 6 advisories | Pre-existing | |
| Prisma 7 deprecation warnings | Pre-existing | `package.json#prisma` |
| `node_modules` linux-x64 only | Preview zip | Other platforms: delete + `npm install` |

---

## Day-by-Day Build History

| Day | Date | What Was Built |
|-----|------|----------------|
| Day 1 | 2026-09-05 | Menu DB expansion, customer order history, specials (bundles), search/navigation in admin |
| Day 2 | 2026-09-08 | Merged storefront + admin into single app, staff auth (PIN + roles), live Orders board, role-gated tabs |
| Day 3 | 2026-09-08 | Quantity steppers on all menu cards/specials/customize dialog, stale-cart reconciliation fix |
| Day 4 | 2026-09-08 | Marketing homepage (scraped from beluchis.co.za), gallery deep-links to order page, contact form + Inbox tab |
| Day 5 | 2026-09-08 | Customer portal (`/portal`), loyalty system (tiers + spend scoring), coupon issuance/redemption |

---

## Design Notes

- **Brand**: Beluchis pizza restaurant (South Africa)
- **Colors**: Brand red `#ad1e22`, accent `#dd3333`
- **Fonts**: Roboto (body), Roboto Slab (headings), Satisfy (script accent) via Google Fonts
- **Credit**: "Website designed by EXPERT SOLUTIONS" was NOT carried over — design credited to Beluchis only
- **WhatsApp**: Floating button links to `wa.me/27714617381`

---

## Next Steps (Documented)

| Priority | Area | What |
|----------|------|------|
| 🔴 High | Production Deployment | Real `ADMIN_PIN`, HTTPS/domain, persistent session store |
| 🟡 Medium | Social Media Tags | Open Graph / Twitter Card meta tags |
| 🟡 Medium | Customer Order Tracking | Self-service status tracking on storefront |
| 🟢 Nice-to-have | Reporting | Sales by hour/day, best sellers in Orders tab |
| 🟢 Nice-to-have | POS/Printer | Kitchen order printing |

---

## Important

The user indicated that they do not want you to execute yet — you MUST NOT make any edits, run any non-readonly tools (including changing configs or making commits), or otherwise make any changes to the system. This supersedes any other instructions you have received.
</system-reminder>
```
