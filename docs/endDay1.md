# endDay1.md — Beluchis Menu DB / Admin Day 1

Date: 2026-09-05

## Summary

Day 1 focus was expanding the Beluchis menu database and its admin UI. We shipped two features:

1. **Customer order history** — customer records with GPS delivery location, contact details, login credentials, and normalized purchase history.
2. **Specials (bundles) + search/navigation** — a live menu construct that bundles existing menu items (with per-item quantities) at a custom price, plus global search and per-tab filtering in the admin UI.

## What was built

### Data layer (`prisma/schema.prisma`, SQLite)
- New models:
  - `Customer` — name, phone, email, GPS lat/long + delivery address, hashed password, flags.
  - `Order` / `OrderItem` — customer purchase history; `OrderItem.item` uses `onDelete: SetNull` (history preserved if a menu item is removed).
  - `Special` / `SpecialItem` — a special bundles one or more items with a per-item quantity; `SpecialItem.item` uses `onDelete: Cascade` (specials are live menu constructs).
- Migration `20260905010920_add_specials` applied on top of `20260905005302_add_customers_orders`.

### API (`server/index.mjs`, Express)
- Full CRUD for customers, orders.
- Full CRUD for specials (`GET/POST /api/specials`, `PUT/DELETE /api/specials/:id`); PUT swaps the item set in a transaction. Validation returns 400 on missing/invalid data.
- `/api/stats` extended to report `customers`, `orders`, `orderItems`, `specials`.

### Admin UI (`public/index.html`, single-file SPA)
- New **Specials** tab: list with parts tags, parts-vs-price total, and a "~% off" badge (cheapest-size sums).
- Add/edit special modal: checkboxes + quantity pickers, live "parts total vs your price" indicator.
- **Global header search** + per-tab search/filters (category / type / active on Items; search on Toppings, Bases, Categories, Specials), result counts, empty-group hiding.

### Seed (`prisma/seed.ts`)
- Fully idempotent (wipe child rows first).
- 3 demo customers (password `beluchis123`), 4 orders, 2 specials (Family Combo R169, Date Night Duo R99).

## Verified
- Migrate + seed clean, run repeatable.
- All specials CRUD + validation tested via curl.
- Page script passes `node --check`.
- Admin page live at `http://localhost:3100`, `/api/stats` reporting all counts.

## Run
- `npm run migrate` · `npm run seed` · `npm run start` (server on port 3100).

## Notes / known issues
- Re-seeding grows SQLite autoincrement IDs every run — never hardcode item IDs in scripts, fetch them via the API instead.
- `pkill -f "<arg>"` was killing the invoking shell (pattern embeds itself); use port/PID-based kills.
- Pre-existing: `npm audit` reports 6 advisories; Prisma 7 deprecation warnings for `package.json#prisma`.
- Admin server runs detached (`setsid node --env-file=.env server/index.mjs >/tmp/beluchis-admin.log &`).

## Next steps (suggestions)
- Customer admin (view/manage customers + orders) in the UI.
- POS/ordering flow using live specials + items for the customer-facing site.