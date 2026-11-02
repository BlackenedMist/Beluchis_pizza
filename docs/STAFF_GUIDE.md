# Beluchi's Pizzas — Staff / Operator Guide

This guide is for admins, cashiers, kitchen staff and drivers. It explains the admin portal, cashier screen, kitchen daemon and StandAlone bridge.

## 1. Logging in

Open `/admin` and sign in with your admin account (username + PIN). Cashiers use `/cashier`. Drivers use `/driver`.

## 2. Admin portal overview

The admin portal has a sidebar of tabs. The main ones:

- **Orders** — live order queue.
- **Users** — customer accounts.
- **Menu / Items** — dishes, categories, sizes, images.
- **Specials** — deals and promotions.
- **Printers** — printer management.
- **Shop (Delivery)** — shop settings, hours, delivery config, social, email alerts.
- **Deliveries** — delivery tracking.

## 3. Orders queue

- Orders appear newest first with status, items, total and payment method.
- **Paid-online orders** show "Total R… · Paid online R…" instead of R0.00.
- **Status filter** — show all or a specific status.
- **Date filter** — pick a day or "All days".
- Change an order's status as it progresses (placed → preparing → out for delivery → delivered). Cancel if needed.
- New-order notifications fire only while an order is still being processed.

## 4. Menu management

- **Categories** — create/rename/reorder; set a deal text badge per category.
- **Items** — name, description, slug, category, image, sizes & prices, active toggle, "show on home".
- **Custom items** — add bases and extra toppings with per-size pricing; seasonal swaps for out-of-season toppings.
- Images upload to `/uploads`.

## 5. Specials (deals)

Tap **+ Add Special** to open the accordion form. Sections (click to expand):

1. **Name & kind** — choose the deal type:
   - **Combo (fixed price)** — a set of items for one price.
   - **BOGO (buy one get one)** — pick N, pay N/2.
   - **Deal (automatic)** — applies when the right items are in the cart.
   - **Pick (buy N get 1 free)** — customer picks N pizzas from a category (or a curated list), pays for N−1.
2. **Category & size** — which category and size the deal applies to.
3. **Item selection** (pick deals only) — curated list of eligible pizzas; toggle **Pay** per item in fixed mode (otherwise cheapest are free).
4. **Description** — short text shown on the card.
5. **Schedule** — weekdays (Mon–Sun) and/or a start/end date range. Only active specials on the current day show on the storefront.
6. **Home page & social** — tile or banner display, "Show on home", "Post to Facebook".

Tap **Save**. Tick "Post to Facebook" to publish the special to the connected page.

## 6. Printers

Tab **Printers** under Store. Each printer: name, type (network/file), host, port, copies per order, enabled, sort order.

- **Add / Edit / Delete** — prompt-based quick editing.
- **Test** — queues a test print; the kitchen daemon prints a test slip.
- **Scan network** — asks the daemon to scan the local subnet for printers on port 9100.
- **Offline alert** — a red banner appears on admin and cashier when any printer is offline or a print failed.
- The kitchen daemon polls this config on startup and every poll; it auto-resolves a changed IP by scanning the subnet and updating the server.

## 7. Shop settings

Tab **Shop (Delivery)**:

- **Hours** — open/close time, online orders toggle. Changing these emails the owner (if an alert email is set).
- **Open/closed** — toggles the shop flag shown on the home page.
- **Delivery config** — enable, shop location (lat/lng), free radius, fee, max radius, beyond fee, minimum order for free delivery.
- **Social** — Facebook Page ID, Page Access Token, Instagram User ID, owner alert email.
- **Connect with Facebook** — opens the FB login dialog to obtain a token (requires the FB app to be configured).

## 8. Users

View customer accounts, reset passwords, view order counts.

## 9. Deliveries

Track deliveries, assign drivers, mark delivered.

## 10. Cashier page (`/cashier`)

- Live order queue with the same filters.
- **New order alert** — sound/notification when a new order arrives.
- **Printer offline banner** — red warning if a printer is down.
- Receipt reprint button per order.

## 11. Kitchen daemon (`kitchen/`)

Headless Node service (port 3101) that polls the server for new orders and prints receipts.

Environment variables:
- `SOURCE_BASE_URL` — server URL (default http://localhost:3100)
- `PRINT_KEY` — shared key for printer endpoints
- `POLL_SECONDS` — poll interval (default 15)
- `AUTO_PRINT` — true/false (default true)
- `AUTO_MARK_PREPARING` — true/false (default true)

Endpoints: `/health`, `/api/print/:id`, `/api/scan?port=9100`.

Behaviour:
- Polls orders; prints each new order on all enabled printers, respecting copies.
- Auto-marks order as "preparing" after a successful print.
- On print failure, scans the subnet to auto-resolve the printer IP and retries.
- Reports heartbeat (per-printer status) to the server.

## 12. StandAlone bridge (`StandAlone/`)

Local bridge (port 3102) used when the kitchen PC is the print source. Stores printers locally in `data/printers.json` and syncs with the server. Local edits push to the server; server config overwrites local on poll.

## 13. Receipts

Kitchen and StandAlone receipts include:
- Shop name, website, phone, VAT number.
- Order number, type (delivery/collection), time, payment method.
- Items with quantities and prices (free items show R0).
- Customer, phone, delivery address.
- Subtotal, discount, **TOTAL AMOUNT**, and for paid-online orders: "Paid online R…" + "No balance due".
- VAT breakdown: Total Excl VAT / VAT Incl. (15%).

## 14. Tips

- Keep the daemon running during service hours.
- If a printer goes offline, the admin and cashier show a red banner — check the Printers tab.
- Use the date filter on the Orders tab to review past days.
- Scheduled specials only show on the storefront on their active days.

*Beluchi's Pizzas — Authentic & Hand Crafted. © 2026*
