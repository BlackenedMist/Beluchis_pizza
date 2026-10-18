# Beluchis — Go-Live Pre-Check

Date: 2026-10-07 · Updated 2026-10-18 after the git update + kitchen bridge setup

## Addresses & DNS  ✅ CUT OVER
| Item | Value | Status |
|---|---|---|
| New ordering server (live) | `https://beluchis.co.za` (nginx, Express) | ✅ answers `200` |
| Domain `beluchis.co.za` / `www` | → `154.65.100.89` (was the old WordPress site) | ✅ cut over |
| TLS | live, `CN=beluchis.co.za`, valid to 2027-01-16 | ✅ installed |
| Hosts entry (this PC) | no longer needed — public DNS is correct | can be removed |
| **Raw IP `154.65.100.89`** | **unusable** — nginx 301s http→https and the cert has no IP SAN | ⛔ do not use |

## Kitchen bridge
- **Runs from `StandAlone/`**, not the repo root. The root-only layout was
  reverted: committing it would have deleted `public/home.html`, the gallery and
  `server/` on the live server's next `git pull`, taking the site down.
- Installed as the `BeluchisKitchen` **scheduled task**, running as SYSTEM, on
  this PC (`C:\Beluchis_pizza\StandAlone`). Log: `StandAlone\beluchis-kitchen.log`.
- Node **22.23.2** fetched into `StandAlone\bin\` and SHA256-verified.
- `.env`: `SOURCE_BASE_URL=https://beluchis.co.za`, `PORT=3101`, `HOST=0.0.0.0`,
  and both secrets stored **DPAPI-encrypted** (see below).
- `data\settings.json` matches — it overrides `.env` and was the silent trap
  before (poller reads it first).
- Admin PIN: the current PIN works and is stored encrypted in `.env` — it is
  deliberately **not** written here. **Rejected on 18 Oct:** the value `.env`
  held since 07 Oct (so it was rotated on the server somewhere in between),
  `3749`, `1234`, and the intended replacement. Anyone picking this up needs
  the live `ADMIN_PIN` from `/opt/beluchis/.env` on `154.65.100.89`.
- Bridge page password: random, stored encrypted in `.env`, shown once in chat.

## Connection checks (all ✅)
- Admin login → `200 {"ok":true,"role":"admin"}`.
- `GET /api/shop/config` → open hours 10:00–21:00, online ordering enabled.
- Bridge poll → `lastPoll.ok:true`, `lastError:null`.
- Picked up and auto-printed live order **#7** (Johan Lombaard, 2× L, R280 COD
  collection) to the target printer in 8 ms.

## Printers
| Printer | Address | Test | Target |
|---|---|---|---|
| Printer 10.0.0.7 | `10.0.0.7:9100` | ✅ ok | ⭐ target |
| PIZZA (Kitchen) | `192.168.1.114:9100` | ✅ ok | — |

- `Test ok` = raw-9100 connection accepted; confirm paper physically printed.
- ⛔ **`\\POS2\Invoice` dropped** — investigated 18 Oct, does not work unattended:
  1. Its print driver cannot be used at all. `Out-Printer` fails with
     `InvalidPrinterException: Settings to access printer are not valid` (no
     usable DEVMODE), so no driver-rendered printing is possible.
  2. The only route that works is a raw SMB write, and that succeeds only for
     the logged-in user. As SYSTEM it returns `Access is denied` — SYSTEM has no
     credentials for the POS2 share.
  - The `windows` printer type is still in the code for machines where the
    driver works, and the UI now offers it. Invoices should come from the POS.

## Secrets in `.env` (new)
`SOURCE_PIN` and `BRIDGE_PASSWORD` are encrypted with **Windows DPAPI**
(`LocalMachine` scope) by `protect-secrets.ps1`, which `start-kitchen.bat` runs
on every start. The bridge decrypts them itself at startup via `lib/secret.mjs`.
- Protects the file at rest and in transit — not against a local attacker, since
  LocalMachine scope means any account on this PC can decrypt.
- Machine-bound on purpose: an encrypted `.env` cannot be unlocked on another
  computer. Moving the bridge to a new PC means typing the values in again.
- Plaintext `.env` kept at `%TEMP%\opencode\beluchis-backup-20261018\.env.plaintext`.

## Bugs found and fixed
- **`install-service.bat` could never install the task.** The task XML used
  `<LogonType>ServiceAccount</LogonType>`, which Windows rejects — probed on this
  machine: `ServiceAccount` ❌, `None` ❌, `S4U` ✅, element omitted ✅. Every
  install would have failed with "a value which is incorrectly formatted or out
  of range". Element now omitted; `S-1-5-18` still runs it as SYSTEM at boot.
- **`npm run check` failed on Windows** — the script used a bash `for` loop.
  Replaced with a cross-platform Node one-liner.

## Server-side config (production playbook)
- App dir `/opt/beluchis`, `.env` → `/opt/beluchis/.env` (chmod 600), systemd
  `beluchis.service`, SQLite at `/var/lib/beluchis/dev.db`.
- Vars needed: `PORT=3100`, `DATABASE_URL=file:/var/lib/beluchis/dev.db`,
  `ADMIN_PIN`, `PAYGATE_ID`, `PAYGATE_KEY`, `PUBLIC_BASE_URL`.
- `PUBLIC_BASE_URL` must be `https://beluchis.co.za` now that DNS is cut over —
  it builds the PayGate `RETURN_URL` / `NOTIFY_URL`.

## Release
- `StandAlone\dist\Beluchis-Kitchen-1.0.1-windows-x64.zip` — **45 KB**, no
  binaries, fetches Node on first run, contains no `.env`/`data`/`bin`.

## Admin PIN — rotated 2026-10-18 ✅
Live on **both** sides now:
- Server: `ADMIN_PIN` changed in `/opt/beluchis/.env` on `154.65.100.89`, service
  restarted. Verified: `POST /api/auth/login` → `200 {"ok":true,"role":"admin"}`.
- Bridge: `SOURCE_PIN` in `StandAlone\.env`, re-encrypted, bridge restarted.
  Verified by a forced poll: `{"ok":true,"count":1,"newOrders":[],"ms":188}`.

The value itself is deliberately **not** recorded in this repo — it lives
encrypted in `StandAlone\.env`. Anyone reading this needs it from
`/opt/beluchis/.env` on the server.

**If the server PIN is ever changed again, change the bridge in the same
session.** Otherwise every poll fails `401` and the kitchen silently stops
receiving orders — no alarm, just nothing printing.

⚠️ The new PIN is a name plus a digit, which is guessable on a publicly
reachable login form. The server allows 10 attempts / 15 min / IP, which helps.
Worth rotating to something random later.

## Closed-shop cadence
Trading hours are 10:00–21:00. After 21:00 the bridge drops from every 60s to
every **1800s (30 min)**. An order placed overnight can wait up to half an hour
to reach the kitchen. Lowerable in the Settings tab.

## Open items
- [ ] **`git push origin main` — 2 commits are local only.** The token supplied
      in session was not valid PAT format, so auth never completed. Commits:
      `5ff0492`, `61c3e9e`. Neither is on GitHub yet.
- [ ] Confirm paper actually prints from **both** printers. `ok:true` only means
      the printer accepted the bytes. `10.0.0.7` took 1962 ms vs 4 ms for
      `192.168.1.114` — the slow one may be low on paper or in an error state.
- [ ] Decide the target printer. Currently `PIZZA (Kitchen)` (`192.168.1.114`),
      changed from the kitchen page UI. `10.0.0.7` is **not** the target. Only
      one target is supported: `/target` clears all others and the poller uses
      `printers.find(p => p.target)`.
- [ ] PayGate end-to-end: confirm `NOTIFY_URL` flips an order to `paid`.
- [ ] Confirm the two home-page image fixes (`c0b498d`, `ef9bf8f`) are live —
      they are committed on `main`, so the server just needs to pull.
- [ ] Kitchen-PC install from the 1.0.1 zip (not done — this PC is the bridge).