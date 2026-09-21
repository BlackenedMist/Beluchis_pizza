# Update Phase 1 — Cashier Portal + Headless Kitchen Printer

**Date:** 2026-09-16
**Status:** Implemented
**Scope:** New `cashier` staff role, a `/cashier` portal page, and a slimmed
headless printer daemon (`kitchen/`) extracted from the StandAlone "Beluchis
Kitchen Bridge". Online orders now print to the kitchen slip automatically and
are marked `preparing` once printed; the cashier marks them `out_for_delivery`
when done.

---

## Why

The shop runs the online storefront on a cloud server (IBM Code Engine / xneelo)
which cannot reach a printer on the shop LAN. The old "Beluchis Kitchen Bridge"
(`/home/admin/Documents/NicksWebBuilder/StandAlone`) already solved LAN
printing, but was a full web app living outside this repo. This phase:

1. Adds a dedicated **cashier portal** page that the cashier keeps open all day
   — it alerts the team when a new online order lands (flash + beep), shows the
   live order board, and lets the cashier mark orders **out for delivery**.
2. Reduces the old Bridge to **just the printer-polling part** — a headless
   daemon (`kitchen/`) that watches the site, auto-prints new `placed` orders to
   the network thermal printer, and then marks each printed order `preparing`.
3. Moves the daemon **into this repo** so the project ships together.

---

## Workflow

```
New online order lands  →  status = placed
        │
        ▼
Kitchen printer daemon (LAN, kitchen/)
  1. sees a NEW placed order (payment not failed)
  2. prints the kitchen slip to the target ESC/POS printer (:9100)
  3. marks the order PREPARING on the site (after a successful print)
        │
        ▼
Kitchen makes the order  →  cashier taps “Mark out for delivery” on /cashier
        │
        ▼
status = out_for_delivery  (delivered is handled by admin/orders/kitchen)
```

- If the printer is down the order stays `placed` and the cashier portal keeps
  flashing it as a new order; reprints are always manual (a printer hiccup never
  triggers endless automatic reprints).
- The daemon is strictly read-only on the site **except** the single
  `preparing` advance after a successful print.

---

## 1. Cloud site changes (this repo)

### `server/index.mjs`

- **Role sets** (`~L206`): `ADMIN_ROLES` now includes `cashier`; new
  `CASHIER_STATUSES = new Set(["out_for_delivery"])`.
- **Orders endpoints** gained `cashier` in `requireRole(...)`:
  - `GET /api/orders`
  - `GET /api/orders/:id`
  - `GET /api/customers/:id/orders`
- **`PUT /api/orders/:id`**: a `cashier` session may only set
  `out_for_delivery`; anything else → `403`. Cashier **cannot** cancel or mark
  delivered (admin/orders/kitchen keep their existing permissions).

### `public/cashier.html` — new portal served at `/cashier`

- Boots `GET /api/auth/me`; no session → `/login`; non-staff roles → `/login`.
- Polls `GET /api/orders` every 10 s (paused while the tab is hidden).
- A `placed` order that hasn't been seen this session triggers:
  - an orange `is-new` flash on the card,
  - a page banner ("NEW ORDER #…"),
  - a **beep** (Web Audio; browsers require one click before sound plays).
- Order card shows: order #, placed time, status badge, payment chip
  (e.g. `Online (PayGate) · paid` vs `Cash on delivery`), delivery/collection +
  address, customer name/phone, item lines with sizes/extras/notes, total.
- **“Mark out for delivery”** button for `placed` / `preparing` orders; calls the
  existing `PUT /api/orders/:id` → `out_for_delivery`. Disabled for
  `out_for_delivery` / later statuses.
- Composition reflects the site; favicon reused from the homepage.

### Other site edits

- `server/index.mjs` — route `app.get("/cashier", …)` guards the page behind a
  staff session (mirrors the `/admin` route).
- `public/login.html` — after login, redirect by role: `cashier → /cashier`,
  everyone else → `/admin`.
- `public/admin.html` — Users tab role dropdown gains **Cashier**; the role
  badge list gains a cashier color.

---

## 2. Kitchen printer daemon (`kitchen/`)

Headless port of the StandAlone Bridge. Runs on a machine **inside the shop LAN**
(Node.js ≥ 18). No web UI, no printer scanner, no SSE page feed — those are
replaced by the cashier portal.

| File | Origin | Change |
|---|---|---|
| `lib/receipt.mjs` | StandAlone copy | unchanged |
| `lib/escpos.mjs` | StandAlone copy | unchanged |
| `lib/printer.mjs` | StandAlone copy | unchanged |
| `lib/store.mjs` | StandAlone copy | unchanged |
| `lib/beluchis.mjs` | StandAlone copy | unchanged (admin login + fetch orders) |
| `lib/poller.mjs` | StandAlone copy | SSE emission dropped; after a successful **auto-print** calls `PUT /api/orders/:id { status: "preparing" }` (gated by `AUTO_MARK_PREPARING`) |
| `index.mjs` | new | daemon entry: read `.env`, build printer from env, start poller, `GET /health` + optional `POST /api/print/:id` reprint endpoint |
| `package.json`, `start.sh`, `stop.sh`, `.env.example`, `README.md`, `.gitignore` | new | run with `./start.sh` |

### `.env`

| Key | Default | Meaning |
|---|---|---|
| `SOURCE_BASE_URL` | `http://localhost:3100` | Public site URL the daemon polls (set to the live origin on the shop box) |
| `SOURCE_USERNAME` | `admin` | Staff login used to read orders + advance `preparing` |
| `SOURCE_PIN` | `1234` | That user's PIN |
| `POLL_SECONDS` | `15` | How often it checks for new orders (min 10) |
| `PRINTER_HOST` | `(empty)` | Thermal printer IP; `local` = file printer |
| `PRINTER_PORT` | `9100` | Printer port |
| `PRINTER_TYPE` | `network` | `network` or `file` (writes slips to `data/prints/*.txt`) |
| `AUTO_PRINT` | `true` | On → auto print new orders; off → log only |
| `AUTO_MARK_PREPARING` | `true` | On → advance order to `preparing` after a successful print |
| `PRINT_KEY` | `` | Shared secret for the optional `POST /api/print/:id` reprint endpoint (empty = reprint disabled) |
| `PORT` | `3101` | Port for `/health` + optional reprint API |
| `HOST` | `0.0.0.0` | Bind address |
| `STORAGE_DIR` | `./data` | Seen-state / print log persistence |

### Behaviour

- First run bootstraps: notes every currently-existing order so **history is
  never reprinted**.
- Restart never reprints anything already seen (`data/state.json`).
- “New” = never seen **and** `status == "placed"` **and** `paymentStatus !=
  "failed"`.
- Order is marked seen **before** printing; a failed print is recorded in the
  log and the site status is left at `placed` so the cashier portal keeps
  flashing it.
- `PRINTER_TYPE=file` allows full testing with no hardware (`data/prints/`).
### Optional reprint

`POST /api/print/:id` reprints an order already seen by the daemon; requires the
`X-Print-Key` header matching `PRINT_KEY`. The cloud-served `/cashier` page
**cannot** call it (a public page can't reach a LAN daemon — mixed origin / no
network path), so there is deliberately **no** print button in the portal.
 Reprint is LAN-only:

```bash
curl -X POST http://<daemon-host>:3101/api/print/<orderId> \
     -H "X-Print-Key: <PRINT_KEY>"
```

---

## 3. Configuration on the shop box

```
cd kitchen
cp .env.example .env
# edit: SOURCE_BASE_URL=<live https origin>, SOURCE_PIN=<real PIN>,
#        PRINTER_HOST=<thermal printer ip>
./start.sh     # writes /tmp/beluchis-kitchen.log, pid in .beluchis-kitchen.pid
./stop.sh
```

Recommended (not required): create a dedicated staff user on the site (Admin →
Users) with role **orders**, name it `kitchen-bridge`, and use that username +
PIN in `SOURCE_USERNAME` / `SOURCE_PIN` so the daemon does not hold the full
admin PIN. A cook/kitchen account also suffices — it can read orders and advance
`placed → preparing`.

`kitchen/` is excluded from the Docker image via `.dockerignore` (it belongs on
the LAN box, not the cloud container).

---

## Roles & permissions (after this update)

| Capability | admin | orders | kitchen | **cashier** |
|---|:--:|:--:|:--:|:--:|
| View orders board / portal | ✅ | ✅ | ✅ | ✅ |
| Advance `placed → preparing` | ✅ | ✅ | ✅ | (daemon) |
| Mark `out_for_delivery` | ✅ | ✅ | ✅ | ✅ |
| Mark `delivered` | ✅ | ✅ | ✅ | — |
| Cancel an order | ✅ | ✅ | — | — |
| Menu / users / loyalty / delivery settings | ✅ | — | — | — |

---

## Files changed / added

- `Updatephase1.md` (this file)
- `server/index.mjs` — cashier role + endpoint gating + `/cashier` route
- `public/cashier.html` **new**
- `public/login.html` — role-aware redirect
- `public/admin.html` — Cashier role option + badge
- `kitchen/` **new** — headless printer daemon
- `.dockerignore` — exclude `kitchen/` from the image
- `README.md`, `docs/API.md`, `PLAN_MODE.md` — documentation

---

## Verification

- `node --check` on all changed JS.
- Boot the site, login as a cashier, confirm the portal renders, the board loads
  from `GET /api/orders`, and `PUT /api/orders/:id` to `out_for_delivery`
  succeeds while `delivered`/`cancelled` are rejected (403).
- `kitchen/` with `PRINTER_TYPE=file` + `SOURCE_BASE_URL=http://localhost:3100`:
  place a test order via the storefront and confirm a slip lands in
  `data/prints/` and the order flips to `preparing`.