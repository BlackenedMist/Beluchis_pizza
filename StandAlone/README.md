# Beluchis Kitchen Bridge

A small app that runs inside the restaurant, watches the online Beluchis
website, and prints every new order to a network thermal printer (4POS /
ESC-POS, normally port 9100). When a new order appears online it is printed
automatically and the screen(s) showing this page beep and ring to catch the
kitchen's eye.

- **No installation** – it only uses what Node.js already provides.
- **Zero dependencies** – copy the folder to any machine on the same network as
  the printers and run one script.
- **No sign-in on this page** – it stays on the restaurant's own network. The
  login to the website is fixed in `.env` (see below).

---

## Quick start

1. Make sure Node.js 18 or newer is installed:

   ```bash
   node -v
   ```

2. Start it. The first run copies `.env.example` to `.env`, prints that message,
   and stops:

   ```bash
   ./start.sh
   ```

3. Edit `.env` and run `./start.sh` again:

   | Setting | Meaning | Example |
   | ------- | ------- | ------- |
   | `SOURCE_BASE_URL` | Address of the online Beluchis website | `http://192.168.1.10:3100` |
   | `SOURCE_PIN` | The **admin PIN** of that website | `1234` |
   | `PORT` | Port for this app's own page | `3101` |
   | `POLL_SECONDS` | How often it checks the website (seconds) | `60` |
   | `HOST` | Network interface to listen on | `0.0.0.0` |

   The bridge always logs in to the website as the **admin** user. The PIN is
   **hardcoded for now** through `.env` — if you change the website's admin PIN,
   update `SOURCE_PIN` here and restart. Nothing else needs the login.

   ```bash
   ./start.sh
   ```

   ```
   Kitchen bridge is running (pid …).
     Open : http://localhost:3101/
     Log  : /tmp/beluchis-kitchen.log
   ```

4. Open that page (`http://<machine-ip>:3101` from any computer on the network).

5. Go to the **Printers** tab and click **Scan network**. The app searches this
   network for printers and lists what it finds. Click **Add** next to your
   printer, give it a name, click **Test** (a test page prints), then click
   **Set as target**.

6. Done. From now on every new online order prints to the target printer and the
   page flashes and beeps.

   > If the scan finds nothing, the printer may be on a different router or not
   > connected. Switch it on and check it is on the same network as this
   > machine, or use **Add a printer manually** at the bottom of the Printers
   > tab — most thermal printers use IP + port **9100**.

---

## The three tabs

### Orders

- Every fetched order appears as a card: order number, Delivery / Collection,
  time, items (with sizes and extras), notes, customer name/phone/address, and
  the total.
- **Preview** shows the exact text that prints (the kitchen slip).
- **Print** prints that order again to the target printer (handy when a slip
  gets lost — reprints are always manual, never automatic).
- When a new order arrives, the card is highlighted, a banner appears, and the
  page beeps (sound works after you have clicked anywhere on the page once).
- The list refreshes automatically; **Refresh** forces it.

### Printers

- **Scan network** — best-effort search of this machine's subnet (each address is
  probed on port 9100, the port network printers use). Anything that responds is
  listed as a *found* printer; you still decide what to add.
- **The printer list** shows every added printer: name, IP:port, last test result,
  and which one is the **target**. Per printer you can:
  - **Set as target** — the one printer that receives new orders automatically
    (only one target at a time).
  - **Test** — prints a test page and reports ✓ ok / ✗ failed.
  - **Rename**, **Remove**.
- **Add a printer manually** — for printers the scan cannot see (different
  subnet, or a non-standard port). Uses name + IP address + port.

### Settings

- **Website address** — the online Beluchis site (same as `SOURCE_BASE_URL`).
- **Check every N seconds** — how often to look for new orders (minimum 10).
  Lower is snappier but generates more traffic to the website.
- **Print log** — a history of every print attempt (order, which printer, ok or
  the error). Useful when a slip did not come out.

---

## How it behaves

- Checks the website for new orders every 60 seconds by default (changeable in
  **Settings** or `POLL_SECONDS`).
- An order counts as **new** only if it has never been seen before, has status
  `placed`, and has no failed payment. Duplicate/paid-failed orders are ignored.
- The order is marked as seen **before** printing, so a printer hiccup never
  causes endless reprints. If printing fails you will see the error in the
  **Print log** and can reprint from the **Orders** tab.
- **First run:** it takes note of all the orders that already exist (so it does
  not reprint the past) and then starts watching for new ones.
- **Restarting** never reprints anything already seen.
- The bridge never changes orders — it is strictly read-only on the website.

## The kitchen slip

Printed on an 80 mm slip with standard ESC/POS commands (init, alignment,
double-height text, feed, cut):

```
           BELUCHIS
         KITCHEN SLIP
--------------------------------
          ORDER #42
--------------------------------
Type: DELIVERY
Time: 08 Sep 2026, 18:42
Payment: CASH ON DELIVERY
--------------------------------
         ITEMS
2x HOT CHICKEN (M)
   + Extra Cheese
     = R80

--------------------------------
        NOTE
RING THE BELL
--------------------------------
Customer: Zola Ndlovu
Tel: 0895556666
To: 12 Ricky Rd, Durban
     TOTAL PAYABLE  R80
```

Payments print as `CASH ON DELIVERY`, `CARD ON DELIVERY`, or `PAID ONLINE` /
`PAYMENT FAILED` for online card orders.

---

## Testing without a real printer

You can point it at a **file printer** instead of a network one — slips get
written to `data/prints/` as `.txt` files instead of being sent over the
network.

Option A — via the API (while the app runs):

```bash
curl -X POST http://localhost:3101/api/printers \
  -H 'content-type: application/json' \
  -d '{"name":"File Test","host":"local","port":0,"type":"file"}'
```

Option B — directly in `data/printers.json` (while stopped), then restart:

```json
{
  "printers": [
    { "id": "file1", "name": "File Test", "host": "local", "port": 0,
      "type": "file", "target": true, "lastTest": null }
  ]
}
```

## Files

| File | Purpose |
| ---- | ------- |
| `server.mjs` | Zero-dependency HTTP server + API (the web page) |
| `lib/poller.mjs` | The watch-and-print engine |
| `lib/beluchis.mjs` | Logs in to the website and fetches orders |
| `lib/receipt.mjs` | Builds the kitchen slip text |
| `lib/escpos.mjs` | Turns the slip into ESC/POS bytes |
| `lib/printer.mjs` | Sends bytes to a printer / writes files |
| `lib/scan.mjs` | Scans the LAN for printers (port 9100) |
| `lib/store.mjs` | Tiny JSON persistence in `data/` |
| `public/` | The web page (Orders / Printers / Settings) |
| `start.sh` | Start (creates `.env` from `.env.example` on first run) |
| `stop.sh` | Stop |
| `data/` | Created at runtime: settings, printers, print history, slips |

## Troubleshooting

| Symptom | Fix |
| ------- | --- |
| "Cannot reach the website" banner | `SOURCE_BASE_URL` is wrong, or the website server is down. Check it in a browser on this machine. |
| Login fails (`Login failed …`) | The website's admin PIN is not `SOURCE_PIN`. Update `.env` and restart. |
| Test fails / nothing prints | Printer is off, on a different network, or port wrong. Verify its IP (check the printer's network settings screen) and that port **9100** is set. |
| Scan finds nothing | The printer is not on the same subnet as this machine, or it is switched off. Scan only reaches one local network; use manual Add for other networks. |
| A slip printed twice | Manual reprints are the only way to force a repeat — automatic printing never sends an order more than once. |
| Weird characters on the slip | Slips are sent as UTF-8; older printer firmware may render unusual characters oddly. Keep item/note text plain. |
| I changed the website PIN | Edit `SOURCE_PIN` in `.env`, then `./stop.sh` and `./start.sh`. |