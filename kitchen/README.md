# Beluchis Kitchen Printer Daemon

Headless LAN-side daemon for the Beluchis site. Runs on a machine **inside the
shop** and watches for new online orders; when one lands (status `placed`,
payment not failed) it prints the kitchen slip to a network thermal printer and
then marks the order `preparing` on the site. The cashier portal `/cashier` then
takes over for the `out_for_delivery` hand-off.

No web UI, no printer discovery — this is the printer-polling half of the old
"Beluchis Kitchen Bridge", moved into the repo and slimmed down.

## Requirements

- Node.js ≥ 20.6 (uses `node --env-file`)
- A machine that can reach **both** the public site (HTTPS) and the thermal
  printer on the LAN (raw TCP :9100)

## Setup

```bash
cd kitchen
cp .env.example .env
# edit at a minimum:
#   SOURCE_BASE_URL  = live site origin, e.g. https://your-domain.co.za
#   SOURCE_PIN       = real staff PIN (prefer a dedicated "orders" role user)
#   PRINTER_HOST     = thermal printer IP, e.g. 192.168.0.50
./start.sh
```

`./stop.sh` to stop. Logs go to `/tmp/beluchis-kitchen.log`; the PID file is
`.beluchis-kitchen.pid`.

## Configuration (`.env`)

| Key | Default | Meaning |
|---|---|---|
| `SOURCE_BASE_URL` | `http://localhost:3100` | Site this daemon polls |
| `SOURCE_USERNAME` | `admin` | Staff login (recommend a dedicated `orders` user) |
| `SOURCE_PIN` | `1234` | That user's PIN |
| `POLL_SECONDS` | `15` | Poll interval (min 10) |
| `PRINTER_HOST` | — | Thermal printer IP |
| `PRINTER_PORT` | `9100` | Printer port |
| `PRINTER_NAME` | `Kitchen printer` | Shown in logs |
| `PRINTER_TYPE` | `network` | `network` (ESC/POS over TCP) or `file` (writes to `data/prints/`) |
| `AUTO_PRINT` | `true` | Auto-print new orders |
| `AUTO_MARK_PREPARING` | `true` | Advance order to `preparing` after a successful print |
| `PRINT_KEY` | *(empty)* | Shared secret for the reprint endpoint (see below) |
| `PORT` | `3101` | Port for `/health` + reprint endpoint |
| `HOST` | `0.0.0.0` | Bind address |
| `STORAGE_DIR` | `./data` | Seen-state + reprint log persistence |

## Behaviour

- **First run bootstraps**: every existing order is recorded in `data/state.json`,
  so order history is never reprinted. Restarts reprint nothing.
- "New" = never-seen id **and** `status === "placed"` **and**
  `paymentStatus !== "failed"`.
- Order id is marked seen **before** printing; a failed print is logged and the
  on-site status is left at `placed` so the cashier portal keeps flagging it —
  a printer hiccup never triggers automatic reprints.
- With `PRINTER_TYPE=file` the whole pipeline can be tested with no hardware:
  slips appear in `data/prints/*.txt`.
- Beeps are not this daemon's job — the cashier page `/cashier` on the site
  alerts the shop (flash + sound) when a new order lands.

## Health + manual reprint

```
GET  /health                    → status JSON
POST /api/print/:id             → reprint an order already seen (X-Print-Key: <PRINT_KEY>)
```

The reprint endpoint is only useful from the shop LAN (the hosted site cannot
reach a LAN port). It is disabled unless `PRINT_KEY` is set. Example:

```bash
curl -s -X POST http://localhost:3101/api/print/123 -H "X-Print-Key: secret"
```

## Auto-status flow

```
placed → (auto-print ok) → preparing → (cashier) → out_for_delivery → delivered
```