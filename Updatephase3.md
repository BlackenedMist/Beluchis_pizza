# Update Phase 3 — Automatic Fixed-Price Deals

**Date:** 2026-10-20
**Status:** Complete (server + storefront + admin + docs verified end-to-end; changes uncommitted)
**Scope:** One customer-facing feature plus its admin surface:

1. **Automatic "buy N for R…" deals** — e.g. *any 2 Large Traditional Pizzas for R200*, applied in the cart with no picker or modal.
2. **Admin → Deals tab** — owner sets the flat price per size, changes it later, or clears it.
3. **BOGO size dropdown fix** — the special modal now offers the sizes a category *actually sells* instead of a hardcoded S/M/L.

No new dependencies, **no schema migration** (one comment updated), and **no changes** to the receipt, cashier board, portal or confirmation email.

---

## Why

Phase 2 gave the owner a **BOGO** special: the customer pays the higher half of a pair, but they first have to open a *"Build your deal"* modal and hand-pick both pizzas. For the classic pizza-shop promotion — *"2 Large for R200"* — that picker is pure friction: the customer already puts two Large pizzas in the cart, and the discount should simply happen. There was also no way to express a **flat** group price at all (`flat` specials are fixed bundles of named items, so they can't say "any 2 of this category, for R200").

This phase adds a third special `kind`, `"deal"`, that reuses the existing `Special` columns and needs no migration.

---

## Locked decisions

| Area | Decision |
|---|---|
| Model | Third `kind: "deal"` on the existing `Special`. Reuses `categoryId`, `sizeLabel`, `count`, `price`. **No migration.** |
| UX | **Automatic.** No modal, no picker. The customer adds pizzas normally; the cart re-prices a qualifying group. |
| Pricing rule | Group qualifying units by (category, size); take `floor(n / count)` groups **cheapest-first**; `saving = max(0, groupBaseTotal − deal.price)`. |
| Clamp | A group only earns the discount if it **beats** the normal price — two R90 Margheritas stay at **R180**, never pushed *up* to R200. |
| Extras | **Never qualify.** The discount is computed on **base price only**, so toppings are always charged in full. |
| Folding | The saving folds into the existing `Order.discountAmount` / `discountLabel`. **No new columns, no display changes.** |
| Source of truth | Priced **server-side** off the real item lines. The client mirrors it purely for the cart preview. |
| Admin | Deals get their own **Deals** tab (one price box per size the category actually sells). The Specials tab hides them. |

---

## Workflow

```
Owner (admin)                        Customer
  ├─ Deals tab                       ├─ /order: adds 2 Large pizzas normally
  │    price per size (S/M/L/…)      │    (no picker, no modal)
  │    "buy this many" count         │
  │    Active / Inactive             ├─ cart re-prices the pair → R200
  │    Save deals                    │    drawer shows "You save R40"
  └─ Specials tab: flat + BOGO only  │
                                     └─ checkout
       ┌──────────────────────────────────────────┐
       │ POST /api/orders                         │
       │  ├─ price item lines from the DB         │
       │  ├─ automatic-deal pass over those rows  │
       │  ├─ + coupon                            │
       │  └─ total = gross charged               │
       │     discountAmount = deal + coupon      │
       │     grandTotal = total − discountAmount │
       └──────────────────────────────────────────┘
```

---

## 1. Data model (`prisma/schema.prisma`)

**No migration.** The `Special` model already had everything needed:

- `kind` — comment updated to `"flat" | "bogo" | "deal"` (comment only).
- `categoryId`, `sizeLabel`, `count`, `price` — reused as-is. For a deal, `price` is the **flat price for the group** and `count` is **how many** make up the group.

Because a deal is defined by *(category, size, count, price)*, any category can get one later (a Pasta special, a Dessert special) with **no code changes** — the admin UI is already generated per category.

---

## 2. Server (`server/index.mjs`)

### Specials CRUD
- `PICK_KINDS = new Set(["bogo", "deal"])`; `normalizeSpecialKind` passes `"deal"` through.
- `validatePickKind(categoryId, sizeLabel, count)` — shared by BOGO and deal: the category must exist, `count ≥ 2`, and `sizeLabel` must be a size that category **actually sells** (a deal pins one; a BOGO may leave it open).
- Deal create/update writes `price: Number(price)` and `pick.count`.

### Order pricing (`POST /api/orders`)
- Regular item lines are remembered in an `itemRows` list as they're priced.
- A **deal's `specialId` is rejected with 400** — `"special N is an automatic deal - send its pizzas as normal item lines"`. Deals have no cart line, so a hand-crafted or stale `specialId` can never claim one twice.
- An **automatic-deal pass** then runs over `itemRows`, mirroring the client exactly:
  - loads active deals (`kind: "deal"`, `isActive: true`, `categoryId != null`, `count ≥ 2`, `price > 0`),
  - collects the units matching the deal's category and size (a qty-3 line contributes **three** units — a unit is one pizza),
  - a `claimed` set stops two overlapping deals discounting the same pizza,
  - sorts the units **cheapest-first** and walks them in chunks of `count`,
  - `saving = max(0, chunkBaseTotal − price)`; a zero-saving chunk is **skipped without claiming**, so the units stay available,
  - a group only adds the label when its saving is > 0.
- **Order arithmetic** (unchanged columns, so every existing surface still renders correctly):

  ```
  total          = foodGross + deliveryFee        // gross charged price
  subtotal       = (foodGross − dealSaving) + deliveryFee   // coupon basis
  discountAmount = dealSaving + couponDiscount
  discountLabel  = [dealLabel, couponLabel].filter(Boolean).join(" + ")
  grandTotal     = total − discountAmount
  ```

  Order items keep their **normal base price**, so the kitchen still sees the real pizzas.

---

## 3. Admin (`public/admin.html`)

- **New "Deals" nav tab** (`#tab-deals`) + `renderDeals()`.
- One card per category: a **price box for every size that category actually sells** (`catSizeList` / `sizeSelectHtml`), a **"Buy this many"** count input, a category-level **Active/Inactive** select, and **Save deals**.
- `saveDeals(catId)` — empty box + existing deal → confirm, then `DELETE`. Non-empty → `POST`/`PUT`. Always writes `showOnHome: false` and names the deal `"<count> <size> <category>"`.
- **Specials tab** now filters out `kind === "deal"`, and the special modal keeps only **flat** and **BOGO**.
- **BOGO size fix:** the hardcoded `["S","M","L"]` is gone. `#sp-cat` calls `renderBogoSizes()`, and `#sp-size` uses `sizeSelectHtml`. A size already configured but no longer sold is kept on open (so saving doesn't silently rewrite it); changing the category drops an invalid size.

---

## 4. Storefront

### `public/shop.js`
- `DEALS` state, `gross()`, `total() = max(0, gross() − DEALS.saving)`, `deals()`.
- `applyDeals(cart)` — the client mirror of the server pass (same grouping, cheapest-first, clamp, `claimed` set, extras excluded).
- `refreshDeals()` runs on every `emit`/`load`/`reconcile`, so the saving is always current.
- `renderCart()` appends a `dealRow()`. Exports `gross, deals, applyDeals, refreshDeals`.

### `public/menu.html` (served at `/order`)
- `SPECIALS` is filtered to `isActive !== false` when the catalog loads, so marking a special inactive in the admin removes its card from the order page — matching what `home.html` already did. Previously the raw API list was used, so an inactive special kept advertising itself (this affected flat/BOGO specials too, not just deals).
- `.cart-line.deal-line` styling; the drawer shows e.g. `2 × R100 = R200 · L` / ~~R240~~ R200 / **You save R40**.
- Deal specials render as **informational cards** (`R200 for 2`, "Add 2 L Traditional Pizzas", *"Applies automatically · you save on the pair"*) with a **Shop {category}** button that flashes and scrolls to the category — deliberately **not** an Add button, because a deal has no cart line.
- `openCheckout()` shows `N items · R260 − deal saving R40 = R220`.
- Checkout sends `pizzas` for special lines, which also **fixes a pre-existing BOGO bug** where the picks were dropped at checkout.

### `public/home.html`, `public/customer.html`
- Both learned the `deal` kind for labels/prices ("Automatic deal", `R200 for 2`). Deals are `showOnHome: false` in the seed, so they don't appear on the home tiles.

### `prisma/seed.ts`
- Seeds **two** Traditional deals so the pre-existing badge *"2 LARGE R200 (2 MEDIUM R150)"* is truthful: **Large R200** and **Medium R150**, `count 2`, active, `showOnHome: false`, sortOrder 10/11. The category is resolved via `categoryBySlug`, never a hardcoded id.

---

## Files changed / added

- `Updatephase3.md` (this file)
- `docs/API.md` — `kind: "deal"` contract, the automatic-deal pricing rule, and the "never send the deal's `specialId`" rule
- `server/index.mjs` — `PICK_KINDS`, `normalizeSpecialKind`, `validatePickKind`, the 400 guard, and the automatic-deal pricing pass
- `public/shop.js` — `DEALS`, `gross`, `total`, `applyDeals`, `refreshDeals`, `dealRow`
- `public/menu.html` — deal cards, deal cart line, checkout summary + payload
- `public/admin.html` — Deals tab, `saveDeals`, `renderDeals`, `sizeSelectHtml`, `renderBogoSizes`
- `public/home.html`, `public/customer.html` — deal labels
- `prisma/schema.prisma` — `kind` comment only (**no migration**)
- `prisma/seed.ts` — the two Traditional deals

---

## Verification

`node --check` passes on `server/index.mjs` and `public/shop.js`; the inline scripts of `menu.html`, `home.html`, `customer.html` and `admin.html` all parse. No test framework in this repo, so verification was an **HTTP API matrix plus a driven browser**, against a scratch seeded DB and then the dev DB.

### API matrix — 10/10, persisted values read back from SQLite

Deals: Traditional Pizzas, **2 L = R200**, **2 M = R150**. (M: Margherita R60, others R88. L: Margherita R90, others R120.)

| # | Cart | `total` | `discountAmount` | `grandTotal` | Checks |
|---|---|---|---|---|---|
| C1 | 2 × Hot Chicken L | 240 | 40 | **200** | deal fires |
| C2 | 2 × Margherita L | 180 | 0 | **180** | **clamp** — never costs more |
| C3 | Margherita + Hot Chicken + Caribbean L | 330 | 10 | **320** | cheapest pair 90+120=210 → R200 |
| C4 | 2 × Margherita L + 2 × Hot Chicken L | 420 | 40 | **380** | pairs cheapest-first: [90,90] saves 0 and is skipped, [120,120] saves 40 |
| C5 | 2 × Hot Chicken M | 176 | 26 | **150** | Medium deal |
| C6 | 2 × Margherita M | 120 | 0 | **120** | Medium clamp |
| C7 | 1 × Hot Chicken L + 1 × Hot Chicken M | 208 | 0 | **208** | sizes do not pair across |
| C8 | 2 × Hot Chicken L + R10 topping each | 260 | 40 | **220** | **extras charged on top, never discounted** |
| C9 | C1 + `BELU-ZANELE` | 240 | 60 | **180** | deal **+** coupon stack; label `"2 L Traditional Pizzas + …"` |
| C10 | the deal's `specialId` sent as a line | — | — | **400** | "… is an automatic deal - send its pizzas as normal item lines" |

`discountLabel` was `null` on every zero-saving case (C2/C6/C7), so no phantom "−R0" row.

### Browser pass (dev server, real UI)

- **Client preview matches the server on all 7 cart cases** (40 / 0 / 10 / 40 / 26 / 0 / 0 savings).
- Drawer renders `2 × R100 = R200 · L` / ~~R240~~ R200 / **You save R40**; with a topping it reads `R260 − R40 = R220`.
- Checkout summary: `2 items · R260 − deal saving R40 = R220`.
- **End-to-end order placed: #16** — success box shows ~~R260~~ **Discount −R40** **Total R220**; the persisted row agrees (`total 260`, `discountAmount 40`, `discountLabel "2 L Traditional Pizzas"`, `grandTotal 220`), with the `OrderItem` at `unitPrice 120, quantity 2, total 260` and the R10 topping in `extras`.
  *(Note: `total` = **260** is gross **including** extras; the discount is computed on the 240 base. `total − discountAmount = 220 = grandTotal` reconciles, and the receipt prints `Subtotal: R260 / Discount: -R40 / TOTAL PAYABLE R220` from `kitchen/lib/receipt.mjs` L101–105.)*
- **Admin Deals tab:** Traditional shows "2 size deals configured" with `L · live` / `M · live`; every category lists **only the sizes it actually sells** (Pizza-Rola → `JNR ROLLA` / `BIG BOY ROLLA`; Chitas → `ONE`). Edited L 200 → **210**, saved, confirmed in `GET /api/specials` **and** live in the storefront cart (saving 30, total 210), then restored to **200**.
- **Specials tab** lists only the two combos — both deals hidden; the kind dropdown offers only *Fixed price bundle* and *Buy a group, pay half (BOGO)*.
- **BOGO size dropdown** now shows `S/M/L` for Traditional and `JNR ROLLA`/`BIG BOY ROLLA` for Pizza-Rola — the old hardcoded S/M/L is gone.
- Menu/home/portal render deals as informational only, with no Add button.
- **Inactive deals:** marked the L+M Traditional deals inactive in the admin Deals tab → `GET /api/specials` reported `active=false`, the deal cards vanished from `/order` (only the two combos remained) **and** the cart stopped discounting (2 × Hot Chicken L charged R240, not R200). Re-activated → both the cards and the R40 saving returned. The admin select is category-level, so it toggles every deal in that category at once.

### Run it locally

```bash
node --env-file-if-exists=.env server/index.mjs      # dev server
```

---

## Status

**Code complete, verified, not yet committed.** All Phase 3 changes are sitting in the working tree alongside the uncommitted Phase 1 + Phase 2 sets.

---

## Out of scope (flagged, not fixed)

- **`server/mail.mjs` cents-vs-rands bug** — an existing `/100` on an already-rands value in the confirmation email. Pre-existing, unrelated to deals, deliberately left alone.
- The receipt's `Subtotal` line includes extras, because `Order.total` is the gross charged price. This is the long-standing Phase 1/2 behaviour and reconciles with `grandTotal`; only the *label* reads slightly loose when a line has toppings. Not changed so the receipt, cashier board, portal and email all keep rendering from the same fields.

## Remaining work

- [ ] Commit the Phase 1 + 2 + 3 change set.
- [ ] Production deployment with a real `ADMIN_PIN`, HTTPS and a persistent session store.
- [ ] Social media auto-poster (deferred from Phase 2).
