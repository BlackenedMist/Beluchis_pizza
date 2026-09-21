# Update Phase 2 — Seasonal Swaps, Shop Hours, BOGO, Favourites & Shoppable Home

**Date:** 2026-09-16
**Status:** In progress (feature-complete on the server + storefront; portal
favourites/reorder just landed, docs + full end-to-end pass outstanding)
**Scope:** Five customer-facing features plus a shared storefront cart module:

1. **Avocado out-of-season swap rule** — block the topping, offer a cheaper substitute.
2. **Configurable shop hours** + owner "force open" override + closed-order guard.
3. **Weekly BOGO special** — owner picks category + size + count, customer pays the higher half.
4. **Customer portal favourites + repeat order.**
5. **Home-page upgrades** — shoppable tiles, live hours, auth-aware header, mini-cart.
6. **`public/shop.js`** — cart/customize/pricing extracted so home and menu share one cart.

A **social-media auto-poster** was requested and deliberately deferred to a future
task (see the last section) — it is not part of this phase.

---

## Why

The storefront was menu-only: everything had to be found on `/order`, prices
were fixed, there was no way to say "we're closed right now", and returning
customers had to rebuild an order from scratch. This phase turns the public site
into a real storefront while keeping the same hand-rolled stack (Express +
Prisma/SQLite + vanilla HTML/CSS/JS, no bundler, **no new dependencies**).

---

## Locked decisions

| Area | Decision |
|---|---|
| Avocado swap | Offer only toppings priced **≤ the avocado price for that size**; if none, offer "remove avocado". Avocado checkbox is disabled while `isInSeason === false`. |
| Hours | One daily open/close pair in **SAST (UTC+2, no DST)** + `forceOpen` override. `shop.onlineEnabled` pauses online ordering independently. |
| BOGO | Owner configures **category + size (optional) + count** (even, ≥ 2). Customer builds `count` pizzas from that category; they **pay for the higher half of the base prices**. Extras are always charged. **Priced server-side.** |
| Favourites | Server-side (`Favorite` model) so they follow the customer across devices; `POST` toggles and returns `{ ok, liked }`. |
| Pictures | `POST /api/upload` takes a **base64 JSON data URL** (no multer), writes to `public/uploads/`, served at `/uploads/*`. |
| Cart | One shared implementation (`public/shop.js`); home tiles add into the same cart; mini-cart offers **View full menu** and **Go to checkout**. |

---

## Workflow

```
Owner (admin)                      Customer
  ├─ Settings → Shop                ├─ / (home): shoppable tiles → shared cart
  │    openTime / closeTime         ├─ /order (menu): sizes, extras, deals
  │    onlineEnabled / forceOpen    ├─ ♥ favourite any dish
  ├─ Items: Picture, Show on home   └─ /portal (customer.html)
  ├─ Toppings: In season?                 favourites + one-tap Reorder
  └─ Specials: BOGO + Show on home
              │
              ▼
   GET /api/shop/config  →  open|closed, onlineEnabled, open/close times
              │
              ▼
   POST /api/orders  →  403 shop_closed for guests while closed (staff bypass)
                     →  BOGO totals computed from the DB, never the client
```

---

## 1. Data model (`prisma/schema.prisma`)

Migration applied: `prisma/migrations/20260916205021_add_phase2_home_seasonal_bogo_favorites/`

- `Category.specials`
- `Item.showOnHome`, `Item.favorites`
- `Special`: `price @default(0)`, `kind @default("flat")`, `categoryId?`,
  `sizeLabel?`, `count @default(2)`, `imageUrl?`, `showOnHome`, `favorites`
- `Favorite` **new** — `@@unique([customerId, itemId])`, `@@unique([customerId, specialId])`
- `Topping.isInSeason @default(true)`
- `Customer.favorites`

---

## 2. Server (`server/index.mjs`)

### Shop hours
- `DEFAULT_SETTINGS` gains `shop.openTime` (10:00), `shop.closeTime` (21:00),
  `shop.onlineEnabled` (true), `shop.forceOpen` (false).
- Helpers: `SHOP_TZ_OFFSET_MIN = 120`, `parseHHMM`, `shopLocalMinutes`,
  `getShopConfig()`, `getShopStatus()` (accepts `?at=ISO` for preview).
- `GET /api/shop/config` → `{ openTime, closeTime, onlineEnabled, forceOpen, open }`.
- `PUT /api/settings` returns `shop` so the admin can render live status.
- `POST /api/orders` rejects non-staff with **403** `{ code: "shop_closed" }`
  while closed; staff bypass so the kitchen can still take a phone order.

### Seasonal toppings
- `isInSeason` accepted on topping create/update; items accept `imageUrl`/`showOnHome`.

### BOGO specials
- `specialIncludes` now joins `category`, so the storefront can show
  "Pick any <category>".
- `normalizeSpecialKind`, `validateBogo(categoryId, sizeLabel, count)` — must be a
  real category, an even `count ≥ 2`, and an optional size.
- BOGO forces `price: 0` and clears the `SpecialItem` rows.
- `POST /api/orders` BOGO branch (≈ L1249): validates each pick against the
  special's category/size, sorts bases descending, zeroes the cheaper half, keeps
  extras payable, and writes **one `OrderItem` row per pizza**.

### Favourites
- `GET /api/customer/favorites` — joined item (with sizes + category) or special.
- `POST /api/customer/favorites` — send exactly one of `itemId` / `specialId`;
  toggles and returns `{ ok, liked }`.
- `DELETE /api/customer/favorites/:id` — ownership-checked (404 otherwise).

### Uploads
- `POST /api/upload` (admin) — `DATA_URL_RE` for png/jpg/gif/webp, 6 MB cap,
  writes to `public/uploads/`, returns `{ ok: true, url }`.
- `express.json` limit raised to `"8mb"`; `public/uploads/.gitignore` keeps the
  dir in git but ignores its contents.

---

## 3. Admin (`public/admin.html`)

- **Items:** picture upload + "Show on home" checkbox.
- **Toppings:** "In season" toggle.
- **Specials:** kind (flat / BOGO), and for BOGO the category, optional size and count.
- **Delivery → Shop:** open/close times, online ordering on/off, force-open
  override, with a live OPEN/CLOSED badge.

---

## 4. Storefront

### `public/shop.js` — **new** (shared, `window.Shop`)
Single source of truth for the cart on every page: localStorage key
`beluchis-cart-v1`, line dedupe, drawer rendering, pricing geometry
(`sizeRowOf`, `basePriceOf`, `topPriceOf`, `availBases`, `availToppings`,
`hasCustom`, `outOfSeasonToppings`, `affordableSwaps`, `bogoBaseTotal`),
`load()`/`reconcile()`, hooks `onCheckout` / `onCartChange`.

The cart array is **mutated in place** so pages can hold `const CART = Shop.cart`.
`emit()` → `saveCart() → renderCart() → syncUI() → onCartChange`.

### `public/menu.html`
Refactored onto `Shop`; adds the BOGO builder modal, the avocado swap confirm,
the closed-shop banner + checkout guard (client-side and on the **403
`shop_closed`** response), deep links (`?checkout=1`, `?item=`, `?cat=`), and a
**♥ favourite** button on every dish and special.

### `public/home.html`
Served at `/`. Replaced the static gallery with tiles driven by
`showOnHome` items/specials (falling back to the old gallery photos), live hours
+ status pill, an auth-aware header (`GET /api/customer/auth/me` → SIGN IN or
MY ORDERS), a closed-shop hero note, and a `#mini-cart` bar driven by
`Shop.onCartChange` / `body.has-cart`.

### `public/customer.html`
Favourites panel (pictures, price "from", Order/View + Remove) and a **Reorder**
button on every past order which rebuilds the cart at today's list prices and
jumps to `/order?checkout=1`.

---

## Files changed / added

- `Updatephase2.md` (this file)
- `prisma/schema.prisma` + `prisma/migrations/20260916205021_add_phase2_home_seasonal_bogo_favorites/`
- `server/index.mjs` — shop hours, BOGO validation + pricing, favourites, upload
- `public/shop.js` **new** — shared cart/catalog module
- `public/menu.html`, `public/home.html`, `public/customer.html`, `public/admin.html`
- `scripts/storefront-smoke.mjs` **new** — CDP storefront test
- `public/uploads/.gitignore` **new**

---

## Verification

`node scripts/storefront-smoke.mjs` (headless Chrome over CDP) — **42 checks,
all passing** — verified both against the dev DB and end-to-end on a **clean
database** (`prisma migrate deploy` + seed, server on `PORT=3210`):

- admin login, BOGO special seeded via the API
- `window.Shop` loaded, 13 categories rendered, "Build your deal" card
- quick-add → badge 1, drawer renders the line
- closed banner shown and checkout blocked with a toast
- BOGO modal: 2 pickers, total **R90**, adds the deal, drawer line, stale-line
  reconciliation after reload
- avocado is out of season: checkbox disabled, swap options
  `Remove … | Swap for Chilli (free)`, swap recorded on the added line
- home: 8 tiles, dynamic hours (`10:00 – 21:00`), status pill, SIGN IN when
  logged out, one-tap Add → mini-cart `1 / R…`, **same cart** as the menu (badge 1)
- customer login from the browser → header switches to MY ORDERS
- home checkout hands off to `/order?checkout=1`
- favourites: heart visible on a dish, toggling marks it (`aria-pressed`), and it
  persists server-side
- portal: the favourite is listed, a past order renders with a **Reorder** button
- reorder rebuilds the cart and hands off to `/order?checkout=1`
- removing a favourite hides the panel and deletes it server-side
- no uncaught page errors (menu **and** after the portal run)

Also `node --check` on `public/shop.js` and the inline JS of `menu.html`,
`home.html` and `customer.html`.

### Run it locally

```bash
node --env-file-if-exists=.env server/index.mjs      # dev server
node scripts/storefront-smoke.mjs                    # 42-check storefront test
```

---

## Status

**Code complete, not yet committed.** Phase 1 + Phase 2 changes are sitting in
the working tree (uncommitted). Plan: do a hands-on test pass tomorrow and, if
happy, commit the change set. If a fix is needed, make it first, then commit.

---

## Remaining work

All Phase 2 items are complete. Deferred to a future phase:

- [ ] Social media auto-poster (see below).
- [ ] Production deployment with a real `ADMIN_PIN`, HTTPS and a persistent
      session store.

### Done

- [x] Extend `scripts/storefront-smoke.mjs` to cover the customer portal
      (favourites toggle from the menu → portal list → remove → reorder) — now
      42 checks, all passing.
- [x] `docs/API.md` — document `/api/shop/config`, BOGO order payloads,
      `/api/upload`, the favourites endpoints, the `shop_closed` 403 and the new
      settings keys.
- [x] `README.md` — Phase 2 features + the shared `shop.js` contract.
- [x] `PLAN_MODE.md` — recorded this phase and removed the stale
      "Plan mode ACTIVE — READ-ONLY" reminder at the top of the file.
- [x] Full end-to-end pass over the five features on a clean database.

---

## Future task — social media auto-poster (not built)

Post new specials to Facebook/Instagram automatically when the owner saves them.

- New `server/social.mjs` using the Meta Graph API; add `special.socialStatus`
  and `special.socialPostId` to the schema.
- One-time Meta setup: app at developers.facebook.com, a Page access token with
  `pages_manage_posts`, `pages_read_engagement`, `instagram_basic`,
  `instagram_content_publish`, an Instagram **Business** account linked to the
  Page, and a System User token.
- Env: `FB_PAGE_ID`, `FB_TOKEN`, `IG_USER_ID`.
- Instagram requires a **public HTTPS image URL** — the local
  `public/uploads/` path will not work, so the image must be uploaded to the
  live origin first.
- Estimated effort: 3–4 hours.
