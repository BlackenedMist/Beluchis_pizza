# datwo.md — Beluchis Merge into a Single App + Staff Auth / Orders Board (Day 2)

Date: 2026-09-08

## Summary

Day 2 merged the storefront and admin into one cohesive app and added a staff
login, roles, and a live Orders board. The old single-file admin SPA
(`public/index.html`, gone) was split into three pages, sessions became
role-aware, and everything was verified end-to-end (curl + Puppeteer, 14/14
checks).

## What was built

### Routing & pages
- `/` — customer storefront (`public/menu.html`, "Beluchis Menu & Order"):
  menu, specials, pizza customization (bases/toppings by size), cart, checkout,
  place order (public).
- `/login` — `public/login.html`: username (optional) + PIN login.
- `/admin` — `public/admin.html`: full admin console. Role-gated tabs:
  **Orders** (live board), **Items**, **Specials**, **Toppings**, **Bases**,
  **Categories**, **Users**. `/menu` now 301-redirects to `/`.
- `public/theme.css` — shared design tokens (colors, type, spacing) used by all
  three pages.

### Auth & roles
- A PIN login for staff (`bcryptjs`): username required except for the built-in
  admin, which uses the server env `ADMIN_PIN` (blank username or `admin` —
  case-insensitive alias added so `admin`/`1234` "just works").
- Roles: `admin` (everything), `orders` (orders incl. cancel, no menu edit),
  `kitchen` (orders board + advance status, no cancel, no menu edit).
- New `StaffUser` Prisma model (Prisma migration `add_staff_users`) — name,
  username (unique), `pinHash`, role, active, last login.
- In-memory sessions (12h TTL, `SameSite=Strict` cookie `beluchis_admin`),
  `GET /api/auth/me` returns `{ principal, role, name }`.
- Users API (`/api/users` CRUD + reset-PIN) — admin-only, `pinHash` never
  serialized. Users tab supports add / edit (username immutable) / delete /
  reset PIN, and you cannot delete your own account.

### Orders board
- Live board polling every 15s (paused when tab hidden), status filter pills
  with tally, name/phone/address + order search, per-role action buttons.
- Status flow `placed → preparing → out_for_delivery → delivered`; cancel for
  admin/orders only. Kitchen card hides Cancel.
- New-order highlight via a `known` set; server re-prices every mutation.

### Menu/data (carried over from Day 1, unchanged)
- Items, sizes, toppings, bases (size-aware pricing), categories, specials.
- Customers/orders/order-items with `OrderItem.item onDelete: SetNull`
  (history survives menu edits).

## Verified
- `requireRole` bug fixed: it previously depended on `requireAuth` having run,
  so any route that only chained `requireRole` always 401'd. It now resolves
  the session itself.
- Login throttle exempts loopback IPs so local dev/testing isn't rate-limited.
- curl matrix: logged-out `/admin` 302→`/login`; wrong PIN 401; env PIN 200
  (role admin); staff 200/403 combinations across roles; anonymous order POST
  201; admin mutations 200/201; orders/kitchen 403; users API strips `pinHash`.
- Puppeteer e2e (`/tmp/opencode/pupp/e2e-admin.js`): 14/14 PASS — login page,
  wrong-PIN error, admin login (`admin`/`1234`), role badge, tab visibility per
  role, orders board cards, staff creation via UI, logout, kitchen hides
  Cancel, storefront loads.
- Test staff users cleaned up (staff list `[]`); test category removed; one
  manual order (customer Jane Doe) remains in `dev.db`.

## Storefront quantity selection (added)
- Quantity steppers (`− n +`, min 1, max 99) on every simple menu card
  (shared by that item's size buttons), in the pizza customize dialog
  (live total shows `unit × qty = line total`), and on each special card.
- Cart/checkout/server already honoured per-line `qty`; nothing server-side
  changed. `public/menu.html` only.
- Verified end-to-end with Puppeteer: stepper math, modal total ×2, special
  qty add, cart badge/grand totals, placed order quantities + re-priced
  total on `/api/orders`. Admin e2e still 14/14.

## Storefront cart reconciliation (added)
- Reported: "menu item 829 not found" at checkout. Root cause: the cart lives
  in `localStorage` (`beluchis-cart-v1`) and was restored verbatim, but every
  re-seed re-inserts the catalog so SQLite autoincrement IDs grow (items were
  903-977; 829 was a stale line from an earlier seed). Checkout POSTed the dead
  id and the server correctly rejected it (`item 829 not found`).
- Fix (client-only, `public/menu.html`): new `reconcileCart()` runs in `load()`
  after the menu is fetched. Prunes lines whose `itemId` isn't an active item
  (or whose size no longer exists), prunes special lines that are
  missing/inactive, refreshes `unitPrice`/`price` from the live catalog, and
  shows a "Removed from cart (no longer available): ..." toast. Server
  validation unchanged (it was correct).
- Verified: `e2e-reconcile.js` injected a cart with a dead item id 829, a dead
  special, and two valid lines with wrong prices → reload pruned both dead
  lines, kept the valid ones at server prices (75/169), badge 5, toast shown,
  order placed with only the 2 valid lines, total = Σ(unit × qty), no stale-id
  400, no JS errors.
- `e2e-qty.js` (quantity suite) still 21/21 PASS; `e2e-admin.js` still 14/14
  and now idempotent for repeat runs (generated users use a per-run suffix so
  leftover `grill1`/`orders1` no longer trip "username already exists").

## Run
- `./start.sh` (Menu `http://localhost:3100/`, Admin `http://localhost:3100/admin`, log `/tmp/beluchis.log`).
- Login: blank username or `admin` + PIN `1234` (from `.env` `ADMIN_PIN`).

## Notes / known issues
- Sessions reset on server restart (in-memory store) — accepted for a
  single-box preview.
- Re-seeding grows SQLite autoincrement IDs (see `endDay1.md`).
- The shipped preview zip pins `node_modules` to linux-x64; other platforms
  should delete it and `npm install` (postinstall regenerates Prisma client).
- Pre-existing: `npm audit` 6 advisories; Prisma 7 deprecation warnings.

## Next steps (suggestions)
- Prod deployment (real `ADMIN_PIN`, HTTPS, domain, persistent sessions).
- Customer order lookup / self-service tracking on the storefront.
- Reporting (sales by hour/day, best sellers).
- Deliverable: `README.md` + an easy-publish preview zip
  `beluchis-preview-2026-09-08.zip` (unzip → `./install.sh` → `./start.sh`).