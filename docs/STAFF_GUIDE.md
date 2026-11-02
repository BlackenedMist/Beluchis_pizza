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

## 4. Menu management (step by step)

### 4.1 Adding a category
1. Open the admin portal -> **Menu -> Categories**.
2. Click **+ Add category**.
3. Enter a name (e.g. "Pizzas") and an optional deal badge text (e.g. "2 for 1").
4. Set the sort order, then **Save**.

### 4.2 Adding an item
1. Go to **Menu -> Items** -> **+ Add item**.
2. Fill in: name, description, slug (URL-friendly, e.g. `bbq-chicken`), category.
3. Upload an image (stored under `/uploads`).
4. Add sizes: click **+ Size**, enter label (Small/Medium/Large) and price for each.
5. Toggle **Active** (visible on the menu) and **Show on home** (appears on the home page tiles).
6. **Save**.

### 4.3 Editing / deactivating an item
1. Find the item in the list (use the search box at the top).
2. Click **Edit**, change fields, **Save**.
3. To hide an item temporarily, toggle **Active** off (it stays in the database but disappears from the menu).

### 4.4 Custom items (bases & extra toppings)
1. Open an item -> **Customise** section.
2. **Bases**: add each base option with its per-size price (0 for the default base).
3. **Extra toppings**: add each topping with its per-size price.
4. For seasonal items, tick "out of season" on a topping - customers will be offered a free swap for an in-season topping of the same value.
5. **Save**.

### 4.5 Reordering
Drag items/categories by their handle, or set the sort order number and save.

### 4.6 Images
- Upload JPG/PNG. Recommended: square, at least 600x600 px for tiles.
- The first image is used as the thumbnail; multiple images show as a gallery in the customiser.

## 5. Specials (deals) - step by step

### 5.1 Creating a special
1. Open **Menu -> Specials** -> **+ Add Special**.
2. The accordion form opens. Expand each section by clicking its header.

### 5.2 Section 1 - Name & kind
1. Enter a **Name** (shown on the card, e.g. "2 Large for R200").
2. Choose the **Kind**:
   - **Combo (fixed price)** - a set of items for one price. Enter the price and quantity.
   - **BOGO** - "Pick N, pay N/2". Set the count (e.g. 2 = pick 2, pay 1).
   - **Deal (automatic)** - applies automatically when the right items are in the cart. Set count and price.
   - **Pick (buy N get 1 free)** - customer picks N pizzas, pays for N-1. Set buy count and pay count.
3. Expand the next section.

### 5.3 Section 2 - Category & size
1. Choose the **Category** the deal applies to (e.g. Pizzas).
2. Choose a **Size** (or "any size").
3. For pick deals, optionally tick "Curated items" to limit which pizzas qualify.

### 5.4 Section 3 - Item selection (pick deals only)
1. Tick the pizzas that qualify.
2. In **fixed** pay mode, tick the **Pay** box on items the customer must pay for; unticked items are free. In **cheapest** mode (default), the cheapest picks are free automatically.
3. **Save** the selection.

### 5.5 Section 4 - Description
Enter a short description shown under the name on the card (optional).

### 5.6 Section 5 - Schedule
1. Tick the **weekdays** the special is active (Mon-Sun).
2. Optionally set a **start date** and **end date** for a limited run.
3. Leave both empty for an always-on special.
4. Only specials active on the current day appear on the storefront.

### 5.7 Section 6 - Home page & social
1. Choose **Display type**: **Tile** (square, in the grid) or **Banner** (full-width row above the grid).
2. Tick **Show on home** to publish to the home page.
3. Tick **Post to Facebook** to publish the special to the connected Facebook page on save.
4. **Save** the special.

### 5.8 Editing / deleting
- Click a special in the list -> **Edit** to change any field, then **Save**.
- Click **Delete** to remove (confirms first).

## 6. Printers

Tab **Printers** under Store. Each printer: name, type (network/file), host, port, copies per order, enabled, sort order.

- **Add / Edit / Delete** — prompt-based quick editing.
- **Test** — queues a test print; the kitchen daemon prints a test slip.
- **Scan network** — asks the daemon to scan the local subnet for printers on port 9100.
- **Offline alert** — a red banner appears on admin and cashier when any printer is offline or a print failed.
- The kitchen daemon polls this config on startup and every poll; it auto-resolves a changed IP by scanning the subnet and updating the server.

### 6.1 Kitchen daemon auth password
At the top of the Printers tab there is a **Kitchen daemon auth password** field.
1. Enter the password the daemon uses (its `PRINT_KEY` environment variable).
2. Click **Save key**. The value is stored on the server and in your browser.
3. Leave blank to disable auth (daemon must also have no `PRINT_KEY` set).
4. The **Scan network** button sends this password to the daemon. If scans fail with 403, the password does not match the daemon's `PRINT_KEY`.

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
