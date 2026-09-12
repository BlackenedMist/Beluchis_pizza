# dayfour.md — Beluchis Marketing Homepage + Contact Inbox (Day 4)

Date: 2026-09-08

## Summary

Day 4 turned the app into a proper website. The storefront moved from `/` to
`/order`, and `/` is now a marketing homepage rebuilt from the scraped
beluchis.co.za WordPress site (hero, signature-dish gallery, Napoletana banner,
WhatsApp + contact form). Gallery tiles deep-link shoppers straight into the
order page's item customize dialog ("pricing dialog"). Contact-form messages
are stored in SQLite and shown in a new **Inbox** tab of the admin console.
The "Website designed by EXPERT SOLUTIONS" credit was not carried over — the
design is credited to Beluchis only.

## What was built

### Routing (server/index.mjs)
- `/` → `public/home.html` (marketing homepage).
- `/order` → `public/menu.html` (storefront: menu, specials, customize, cart,
  checkout).
- `/menu` → 301 redirect to `/order` (old storefront links keep working).
- `/home/*` static assets under `public/home/` (hero `cover.jpg`, `logo.png`,
  `favicon.jpg`, Napoletana images, and the 9 gallery tiles).

### Homepage (`public/home.html`)
- Sticky white nav (logo + HOME / MENU / CONTACT / ORDER NOW), full-bleed hero
  over `cover.jpg`, "Authentic & Hand Crafted" section with the 9-item gallery
  grid from the original site, "Napoletana Style Pizzas Now Available"
  banner (medium pizzas +R20 Napoletana base, 48h dough), contact section
  (address/hours/tel/email + working contact form), footer in brand red
  `#ad1e22`, floating WhatsApp button (`wa.me/27714617381`) and back-to-top.
- Brand fonts via Google Fonts with system fallback: Roboto (body),
  Roboto Slab (headings), Satisfy (script accent). Accent `#dd3333`.
- **No "Website designed by EXPERT SOLUTIONS"** credit anywhere.
- Floating social bar (bottom-right): Facebook (`#1877f2`), Instagram (gradient)
  and WhatsApp (`#25d366`). Footer also has Facebook/Instagram icon links.
- Contact form posts to `POST /api/contact` (name + phone required, email
  optional, message required).

### Gallery → order deep links
- 7 tiles map to a catalog item by slug and open that item's customize dialog
  on `/order`: `cheddar-steak-melt`, `regina`, `working-class-hero`,
  `bbq-chicken`, `rib-delight`, `rock-n-roll`, `salami-supreme`.
- 2 tiles with no DB equivalent scroll to the nearest category on `/order`:
  "Three Cheese & Rocket" → `?cat=gourmet-pizzas`, "BBF PIZZA" →
  `?cat=deluxe-pizzas`. Both paths were explicitly agreed with the user.
- `menu.html` gained: `data-cat-slug`/`data-item-slug` attributes, a flash
  highlight animation, a global `activeItems` list, and `handleDeepLink()`
  which reads `?item=` (open customize dialog, or scroll for non-custom items
  / name-slug fallback) and `?cat=` (scroll to category).

### Contact inbox (DB + API)
- `prisma/schema.prisma` + migration `20260908181700_add_contact_messages`:
  `ContactMessage` model (name, email?, cellphone?, message, isRead, createdAt).
- API: `POST /api/contact` (public), `GET /api/contact` +
  `PUT /api/contact/:id` (admin/orders), `DELETE /api/contact/:id` (admin).
  `GET /api/stats` now also returns `contact`.
- `public/admin.html`: new **Inbox** tab (`data-roles="admin,orders"`) with
  unread highlighting, mark read/unread, mark-all-read, delete, refresh; the
  header "View menu" link now points to `/order`.

## Files changed

- `db_data/server/index.mjs` — routes (home/order/menu-301) + contact API +
  stats contact count + `requireRole("admin", "orders")` usage.
- `db_data/public/home.html` — **new** marketing homepage.
- `db_data/public/menu.html` — deep-link support (`?item=` / `?cat=`), flash
  CSS, data attributes, global `activeItems`.
- `db_data/public/admin.html` — Inbox tab + mark/delete handlers, View menu →
  `/order`.
- `db_data/public/home/` — **new** asset folder (hero, logo, favicon,
  Napoletana images, 9 gallery tiles copied from
  `Test_Pizza/www.beluchis.co.za/wp-content/uploads/`, hero cover from the
  Next.js port).
- `db_data/prisma/schema.prisma` + `db_data/prisma/migrations/20260908181700_add_contact_messages/`.
- `db_data/README.md` — routes, components, API, data model updated.

## Verification (all passed)

- `node --check` on `server/index.mjs` + the inline JS of menu.html/admin.html.
- `npx prisma migrate dev --name add_contact_messages` applied cleanly.
- Booted on `:3100`:
  - `GET /` → 200 `text/html` (home.html).
  - `GET /order` → 200 (storefront).
  - `GET /menu` → 301 → `/order`.
  - `GET /home/cover.jpg`, `/home/gallery/regina.jpg` → 200 `image/jpeg`.
  - `POST /api/contact` → 201 (row stored).
  - `POST /api/auth/login` (env PIN `1234`) → `GET /api/contact` list →
    `PUT /api/contact/:id {isRead:true}` → `DELETE` → empty list. 401/403
    without a session.
  - `GET /api/stats` includes `"contact":1`.
- Headless Chrome (`--headless=new --dump-dom`):
  - Homepage title + 9 gallery links render; no "EXPERT SOLUTIONS" text.
  - `/order?item=regina` → customize modal opens + item flashed.
  - `/order?cat=gourmet-pizzas` → Gourmet section flashed + present.
- Verified the served pages contain zero "EXPERT SOLUTIONS" references.

## Run

- Live: `http://localhost:3100/` (homepage) and `http://localhost:3100/order`
  (storefront). Admin at `/admin` (blank username or `admin` + PIN `1234`).
  Log `/tmp/beluchis.log`.

## Notes / known issues

- Sessions remain in-memory (reset on restart) — accepted for preview.
- Homepage hero + one Napoletana image come from the Next.js port's processed
  `cover.jpg`/`napoletana.jpg`; the gallery tiles are the original WordPress
  uploads (unedited JPGs).
- Re-seeding grows SQLite autoincrement IDs — never hardcode IDs.
- Shipped `node_modules` is linux-x64; other platforms `rm -rf node_modules &&
  npm install` (postinstall regenerates the Prisma client).

## Deliverable

`README.md` + a rebuilt preview zip `beluchis-preview-2026-09-08.zip`
(unzip → `./install.sh` → `./start.sh`). The user will add the remaining
social-media tags on top of this build.