# daythree.md — Beluchis Storefront Quantity Steppers + Stale-Cart Fix (Day 3)

Date: 2026-09-08

## Summary

Day 3 made the customer storefront quantity-aware and hardened it against a
real-world edge case:

1. **Quantity steppers** (`− n +`, min 1, max 99) everywhere the customer adds
   something: on every simple menu card (shared with that item's size buttons),
   inside the pizza customize dialog (live total shows `unit × qty`), and on
   each special card. Cart, checkout, and server already honoured per-line
   `qty` — no server changes were needed.
2. **Stale-cart reconciliation** — the fix for a bug the owner hit live:
   *"menu item 829 not found"* at checkout (see below).
3. Preview zip rebuilt + fresh-boot verified. Live server on `:3100` was never
   restarted (static files are read per request, so the fix was live instantly).

## The bug: "menu item 829 not found"

- The cart lives in `localStorage` (`beluchis-cart-v1`) and was restored
  **verbatim** on every page load.
- Every re-seed re-inserts the WordPress catalog, so SQLite autoincrement IDs
  grow (this is the known "Re-seeding grows IDs" issue). The ID `829` was valid
  under an earlier seed; the current catalog is items **903–977**.
- The stale line still *displayed* fine in the cart (it stores name/size/price),
  but checkout POSTed the dead `itemId`, and the server correctly rejected it:
  `item ${line.itemId} not found` (`server/index.mjs` POST `/api/orders`).
- Diagnosis ruled out browser HTTP caching — API responses use ETag +
  `max-age=0` (always revalidated), so the live catalog was fresh; the troublemaker
  was purely the unvalidated localStorage cart.

## Fix (client-only — `public/menu.html`)

New `reconcileCart()` runs inside `load()` after the menu, specials, and sizes
are fetched. It:

- Drops `kind:"item"` lines whose `itemId` is not an active item, or whose
  `sizeLabel` no longer exists / is no longer active (auto-fills the size when
  an item has exactly one active size).
- Drops `kind:"special"` lines whose special is missing or inactive.
- Refreshes `unitPrice` / `price` from the live catalog so the cart always
  agrees with what the server will charge.
- On any removal: `saveCart()`, shows a
  *"Removed from cart (no longer available): …"* toast, and re-renders the
  cart UI / badge.
- Leaves unknown/malformed lines untouched (never destroys data we can't judge).

Server-side validation is unchanged (it was correct). Accepted scope: re-seeds
will still change IDs in the future, but a stale cart can no longer feed the
dead IDs back to checkout.

## Verified

Puppeteer (live server, HTTP + admin session):

- `e2e-reconcile.js` — injected a cart with a dead item `829`, a dead special,
  and two valid lines carrying wrong prices → reload pruned both dead lines,
  kept the valid ones at server prices (75 / 169), badge 5, toast shown, order
  placed with only the 2 valid lines, total = Σ(unit × qty), **no** `not found`
  400, no page/console JS errors. 14/14 checks PASS.
- `e2e-qty.js` (quantity suite) — 21/21 PASS: stepper math on cards, shared
  size-button add, min-clamp at 1, modal stepper with `R90 × 2 = R180`,
  special steppers, cart badge/grand totals (R743), placed order quantities
  `2,2,3` and server total = Σ(unit × qty).
- `e2e-admin.js` (admin regression) — 14/14 PASS. Hardened the harness: the two
  users it creates now use a per-run suffix (`grill*` / `orders*`) so repeat
  runs no longer trip the unique-username 400 ("username already exists") on
  leftover state.
- `node --check` on the inline storefront script: `SYNTAX OK`.

Test data was cleaned from `dev.db` after the runs (test customers/orders and
leftover staff users removed); the DB is back to the clean 4-order seed.

## Files changed today

- `db_data/public/menu.html` — quantity steppers + `.stepper` / `.special-actions`
  CSS + `reconcileCart()`.
- `db_data/README.md` — Components row updated (quantity steppers + cart
  reconciliation).
- `datwo.md` — appended the two new "(added)" sections for cross-reference.
- `beluchis-preview-2026-09-08.zip` — **rebuilt** with the updated
  `menu.html`/`README.md` and a freshly reseeded `dev.db`
  (14 categories, 75 items, 40 toppings, 5 bases, 1480 item→topping links,
  185 item→base links, 3 customers, 4 orders, 7 order items, 2 specials,
  staff 0). ~97 MB, 5838 files.
- Test harnesses in `/tmp/opencode/pupp/`: `e2e-qty.js`, `e2e-reconcile.js`,
  `e2e-admin.js`.

## Run

- Live: `http://localhost:3100/` (Menu) and `http://localhost:3100/admin`
  (login: blank username or `admin` + PIN `1234` from `.env`). Log
  `/tmp/beluchis.log`.
- Fresh-boot verification of the zip passed on `PORT=3405` (menu 200, steppers
  + `reconcileCart` served, `/login` 200, authed `/admin` 200,
  `/api/orders` → 4 seeded orders). Verify instance was stopped afterwards.

## Notes / known issues (unchanged)

- Sessions are in-memory and reset on server restart (accepted for preview).
- Re-seeding grows SQLite autoincrement IDs — never hardcode IDs; the client
  cart reconciliation now makes this invisible to storefront customers.
- Shipped `node_modules` is linux-x64; other platforms delete it and
  `npm install`.

## Next steps (suggestions)

- Prod deployment (real `ADMIN_PIN`, HTTPS/domain, persistent sessions).
- Customer order lookup / self-service tracking on the storefront.
- Reporting (sales by hour/day, best sellers).
- `README.md` + the published preview zip
  `beluchis-preview-2026-09-08.zip` are the deliverable: unzip → `./install.sh`
  → `./start.sh`.