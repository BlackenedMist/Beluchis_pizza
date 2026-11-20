# Beluchis production configuration — hardcopy record

This is the single record of **every property needed to restore the live server**
after a reset/rebuild. It is safe to keep in git: **no secret values are stored
here**. Secrets live only in `/var/lib/beluchis/.env` (mode 600) and in the
encrypted off-server backup; this file tells you which ones they are.

Live host: `ubuntu@154.65.100.89` (xneelo). App: `/srv/beluchis/app`.
Service: `beluchis.service`. DB: `/var/lib/beluchis/dev.db`.
Last audited: **2026-11-20** (commit `9808bf3` at audit time).

## 1. Environment variables (`/var/lib/beluchis/.env`)

Template: `config/beluchis.env.example` (copy it, fill values, chmod 600).

| Key | Required | Expected / notes |
|---|---|---|
| `NODE_ENV` | yes | `production` (no default `1234` admin PIN) |
| `PORT` | yes | `3100` — nginx proxies `127.0.0.1:3100` |
| `HOST` | yes | `0.0.0.0` |
| `DATABASE_URL` | yes | `file:/var/lib/beluchis/dev.db` (persistent volume) |
| `PUBLIC_BASE_URL` | yes | `https://beluchis.co.za` — PayGate notify/return + claim invites |
| `ADMIN_PIN` | yes | **secret**. If changed, also update `SOURCE_PIN` in the Windows kitchen bridge `StandAlone/.env`, then restart the bridge; otherwise polls silently 401. |
| `SMTP_HOST` | yes | `smtp.gmail.com` |
| `SMTP_PORT` | yes | `587` |
| `SMTP_USER` | yes | **secret** — Gmail account |
| `SMTP_PASS` | yes | **secret** — Gmail **app password** (a bad one caused the Nov 13–14 invite failures: SMTP `535 5.7.8` / `534 5.7.9`) |
| `MAIL_FROM` | yes | sender address |
| `PAYGATE_ID` | online payments | **secret** — merchant ID. Blank disables online checkout. |
| `PAYGATE_KEY` | online payments | **secret** — encryption key, use **verbatim**, never base64-decode |
| `PAYGATE_ENDPOINT` | yes | `https://secure.paygate.co.za` |

Restore secret values from the encrypted backup only. Never paste them into
this file, the repo, chat, or a log.

## 2. `Setting` table (stored in the SQLite DB, edited in Admin → Delivery/Shop)

| Key | Value to set | Notes |
|---|---|---|
| `shop.lat` | `-33.646` | Worcester CBD. **BUG-1:** this was blank on the live box and `Number("")` became `0`, so `/api/delivery/config` reported the shop at `(0,0)` and every real address fell into the R95 "beyond" band. The code now treats blanks as the default, but set the explicit value anyway. |
| `shop.lng` | `19.448` | see above |
| `shop.openTime` | `10:00` | CAT (UTC+2), `HH:MM` |
| `shop.closeTime` | `20:30` | CAT, `HH:MM` |
| `shop.onlineEnabled` | `true` | online ordering |
| `shop.forceOpen` | `false` | override |
| `shop.forceClosed` | `false` | override |
| `shop.ownerEmail` | `beluchis.worcester@gmail.com` | owner alerts |
| `delivery.enabled` | `true` | delivery on |
| `delivery.freeRadiusKm` | `5` | free band 0–5 km |
| `delivery.maxRadiusKm` | `10` | standard band 5–10 km |
| `delivery.feeAmount` | `85` | standard fee, R85 |
| `delivery.beyondFeeAmount` | `95` | beyond band, R95 |
| `delivery.minOrderAmount` | `200` | food subtotal needed for free delivery |
| `delivery.noDeliveryRadiusKm` | *(blank)* | blank keeps "deliver everywhere at R95"; set a value only if the owner wants a red no-delivery zone |
| `mail.inviteSubject` | owner copy | claim-invite subject |
| `mail.inviteBody` | owner copy, uses `{firstName}` and `{url}` | invite URL is now `/portal?claim=1` (never `/login`) |

Additional keys written by the delivery-map module (managed by the app, do not
set by hand): `delivery.streetsRefreshedAt`, `delivery.streetsCounts`,
`delivery.streetsLastError`.

## 3. Delivery zones (derived from the settings above)

The running app derives zone bands from the **same** settings used to price an
order (`server/deliveryStreets.mjs` → `GET /api/delivery/zones`). Do **not**
import the demo values from `delivery-map/` (3 km / R30) — the correct live data
is the table above.

| Zone | Distance | Fee |
|---|---|---|
| `free` | 0–5 km, food subtotal ≥ R200 | R0 |
| `free` below threshold | 0–5 km, subtotal < R200 | R85 |
| `standard` | 5–10 km | R85 |
| `beyond` | > 10 km | R95 |
| unverified | address without GPS | R85, shop confirms by phone |
| collection | no address/coords | R0 |

After any radius/fee change: run `POST /api/delivery/streets/refresh` (admin) or
`npm run streets:refresh`, then confirm the green and yellow zones have
non-zero street counts before relying on the address wizard.

## 4. Restore procedure

1. Restore the newest DB backup (`/var/backups/beluchis-*.db`) over
   `/var/lib/beluchis/dev.db` (or let `prisma migrate deploy` create a fresh one
   and re-seed).
2. Copy `config/beluchis.env.example` → `/var/lib/beluchis/.env`, fill values
   from the secret store, `chmod 600`.
3. Apply the `Setting` rows from section 2 (admin UI or SQL) — especially the
   shop centre (BUG-1).
4. `sudo systemctl daemon-reload && sudo systemctl restart beluchis.service`
5. Verify:

```bash
curl -s http://127.0.0.1:3100/api/delivery/config
# must show shop lat=-33.646, lng=19.448 (NOT 0,0), 5/10/85/95/200

curl -s http://127.0.0.1:3100/api/delivery/zones
# free 0-5, standard 5-10, beyond 10+

curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:3100/api/categories
curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:3100/portal
```

6. Sessions are in-memory and reset on restart: staff log in again with their
   PIN, customers log in again with cellphone + password.

## 5. Related gotchas

- The new code trusts one nginx hop (`app.set("trust proxy", 1)`) so the login
  throttle uses the real client IP (20 attempts / 15 min, CGNAT-friendly).
- Claim invitations now link to `/portal?claim=1`, which opens the claim form.
  The old `/login` link led to the staff PIN page and was a dead end.
- `POST /api/customer/auth/register` no longer crashes with a P2002/500 when an
  imported account already owns the email — it returns a claim invitation.
- A claim can use cellphone **or** email (for the few imported rows with no
  phone), always verified with the exact first name.
- Login, reset-password and the My-details editor also accept **email or
  cellphone**, so email-only accounts stay usable after the session expires.
