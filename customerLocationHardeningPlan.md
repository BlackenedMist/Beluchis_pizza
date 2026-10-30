# Customer Location Hardening — Deployment Plan

**File:** `customerLocationHardeningPlan.md`
**Status:** Deployed on **2026-10-30** (early hotfix for the broken delete button)
**Code status:** Committed and pushed (`a8c3d71`), **deployed**
**Production code:** `a8c3d71`
**Owner:** Beluchis engineering
**Live target:** `ubuntu@154.65.100.89` — app `/srv/beluchis/app`, service `beluchis.service`
**Database:** `/var/lib/beluchis/dev.db` (SQLite)

---

## 0. Why this plan exists

Elda Barton (customer 5) could not add a delivery location: she had three duplicate
"Home" rows, all without map pins, so every new save hit the 3-location cap with
`"You can save up to 3 locations. Delete one first."`

The live data was fixed on **2026-10-30**:

- Deleted duplicate address ids `2` and `3`.
- Kept id `1` and set the canonical address:
  `8 Du Toit Avenue, Langerug, Worcester, 6850`
- Backfilled the pin from her own prior order: `-33.6430197, 19.4375326` (1.02 km).
- Left it as the default location.

The code hardening that prevents this recurring is committed but intentionally not
deployed yet. This document is the checklist for doing that safely next week.

---

## 1. Scope

### In scope

1. Deploy commit `37432d0` (`fix: harden customer delivery locations`) to production.
2. Verify the address API and portal behaviour on the live site.
3. Confirm Elda can save/edit/delete locations again.
4. Record the follow-up for the five legacy unpinned locations.

### Out of scope

- No database schema migration.
- No dependency or Prisma changes.
- No pin guessing for legacy rows (decision: leave them for customers to pin).
- No changes to the five valid pinned customers unless they report a problem.

---

## 2. Changes in commit `37432d0`

| File | Change |
|---|---|
| `server/index.mjs` | Duplicate-address guard on create; duplicate checks only on fields actually changed for updates; fixed whitespace normalization (`\s` instead of literal `\\s`); address-key normalization now trims after punctuation removal |
| `public/customer.html` | Always renders saved locations; "Pin needed" badge; **Use for delivery**, **Edit**, **Delete** on every card; clearer cap message; error state when loading fails |
| `public/menu.html` | Checkout links to `/portal` to manage saved locations |
| `docs/API.md` | Documents `{ items, limit, used }`, duplicate address/label `400` responses, and update semantics |

Commit: `37432d0` — pushed to `origin/main`.

---

## 2.5 Deployment record (2026-10-30)

Deployed early because the portal delete button was broken in production
(`DELETE /api/customer/addresses/' + a.id + '`), which blocked Elda from
removing a location.

- Pre-deploy backup: `/var/lib/beluchis/backups/dev-pre-a8c3d71-20261030-125942.db` (`PRAGMA integrity_check` = ok)
- Pulled `75c8d29` → `a8c3d71`
- Restarted `beluchis.service` (active, no startup errors)
- Smoke checks passed: portal serves `addr-limit-msg` and `data-addr-del`, `/order` 200,
  unauthenticated `/api/customer/addresses` returns 401, commit `a8c3d71`
- No DB migration or dependency change

## 3. Current production/data state

### Elda (customer 5)

- Exactly 1 saved location: `Home`, canonical address, pinned, default.
- Backup before the fix:
  `/var/lib/beluchis/backups/dev-pre-elda-fix-20261030-123826.db`
- Audit export:
  `/var/lib/beluchis/backups/elda-addresses-20261030-123826.json`

### All other customers with saved locations

Pre-fix there were **13 saved-location rows**: Elda's 3 plus **10 other customers**
with one row each. There were never 13 other users.

**Valid and pinned (no action):**

| Customer | Address | Distance from shop |
|---|---|---|
| Angel van den Berg (1426) | 02 Jean Welz Street, Langerug | 1.64 km |
| Paul Mitton (1534) | 1 Aandblom, Fairy Glen | 1.16 km |
| Andries le Roux (1630) | 23 Quellerie Road, Van Riebeeck Park | 2.42 km |
| Benita Titus (1690) | 7 Heller Boulevard | 3.91 km |
| Petrus Coetzee (1745) | 17 Taylor Street, Hospital Park | 4.55 km |

All are inside the 5 km free-delivery radius.

**Unpinned legacy rows (decision: leave for the customer to fix):**

| Customer | Saved address | Notes |
|---|---|---|
| Annamarie Viljoen (518) | 8 Nassau Straat, Van Riebeeck Park Worcester | No pin in saved row or any order |
| Juanita de Villiers (999) | 51 Malan straat Langerug | No pin in saved row or any order |
| Justine Werth (1569) | 1 Haarlem Street, Van Riebeeck Park, Worcester, 6850 | No pin in saved row or any order |
| Ashley Petersen (1735) | 65 Vicky Street | No pin; account never claimed |
| Alexander Otto (1739) | 4 Nel Street hospital hill | No pin; only order was collection |

No historical pin exists for these five: their orders have `deliveryLat`/`deliveryLng`
null, and the old WordPress dump has no latitude/longitude metadata. Do **not** invent
coordinates. After deployment the portal will show "Pin needed" and let them drop an
accurate pin.

---

## 4. Verification already completed locally

Tested against a throwaway SQLite database with a dedicated test customer. All checks passed:

- Login works.
- Create first location works.
- Duplicate address blocked with `400` (case/whitespace/punctuation-insensitive).
- Duplicate label blocked with `400`.
- Missing pin blocked with `400`.
- Create second and third locations works.
- Fourth location blocked at the 3-location cap.
- `PUT { isDefault: true }` works without sending `label`/`address`.
- `PUT { isDefault: true }` also works on a simulated legacy duplicate row.
- `DELETE` works.
- `GET /api/customer/addresses` returns `{ items, limit, used }` with the default first.

Command-level syntax check: `node --check server/index.mjs` passed.

---

## 5. Deployment checklist (next week)

### 5.1 Pre-flight (local)

- [ ] Confirm `origin/main` is `37432d0` and the working tree is clean apart from known untracked files.
- [ ] Confirm no newer commits are pending that should ship together.
- [ ] Announce a short maintenance window (restart takes seconds; safest outside trading hours).

```powershell
git fetch origin
git status --short
git log --oneline -3 origin/main
```

### 5.2 Backup production DB

```bash
ssh ubuntu@154.65.100.89
STAMP=$(date +%Y%m%d-%H%M%S)
sudo -u beluchis sqlite3 /var/lib/beluchis/dev.db ".backup '/var/lib/beluchis/backups/dev-pre-address-hardening-$STAMP.db'"
sudo -u beluchis sqlite3 "/var/lib/beluchis/backups/dev-pre-address-hardening-$STAMP.db" "PRAGMA integrity_check;"
```

Expected: `ok`.

### 5.3 Deploy code only

```bash
cd /srv/beluchis/app
git fetch origin
git log --oneline -1 origin/main      # expect 37432d0
git pull --ff-only origin main
git log --oneline -1                  # expect 37432d0
```

Do **not** run `prisma migrate`, `prisma db push`, or the address normalization script.
No schema or dependency changed.

### 5.4 Restart and check service

```bash
sudo systemctl restart beluchis.service
sudo systemctl status beluchis.service --no-pager
sudo journalctl -u beluchis.service -n 50 --no-pager
```

Expected: `active (running)`, no startup errors, no Prisma errors.

### 5.5 Smoke test

- [ ] `curl -sS http://127.0.0.1:3100/portal | grep -c 'addr-limit-msg'` returns at least `1`.
- [ ] `curl -sS http://127.0.0.1:3100/portal | grep -c 'Use for delivery'` returns at least `1`.
- [ ] `curl -sS -o /dev/null -w '%{http_code}' http://127.0.0.1:3100/api/customer/addresses` returns `401` (unauthenticated, as expected).
- [ ] `curl -sS -o /dev/null -w '%{http_code}' http://127.0.0.1:3100/order` returns `200`.
- [ ] Check nginx access/error logs for new `500`s after restart.

If the service port differs, read it from `/var/lib/beluchis/.env` instead of assuming `3100`.

### 5.6 Functional verification with a real account

Use one controlled test account or ask a staff member to verify in the portal:

- [ ] Saved locations are always visible.
- [ ] Each card has **Use for delivery** (when not default), **Edit**, **Delete**.
- [ ] Editing a location and dropping a pin saves successfully.
- [ ] Adding a duplicate address is rejected with the "already saved" message.
- [ ] Adding a fourth location is blocked with the cap message.
- [ ] "Manage saved locations" link appears at checkout.

No production test customer should be left behind; delete any temporary row/account afterwards.

---

## 6. Rollback

No DB migration is involved, so rollback is code-only:

```bash
cd /srv/beluchis/app
git checkout 75c8d29
sudo systemctl restart beluchis.service
sudo systemctl status beluchis.service --no-pager
```

If data repair is ever needed, restore the pre-deploy backup only after stopping the
service and confirming the backup integrity. The Elda fix is already live and should
not be reverted unless there is a data issue.

---

## 7. Post-deploy follow-ups

- [ ] Confirm Elda can open the portal, see her Home location, and add another location.
- [ ] Monitor `journalctl -u beluchis.service` and nginx logs for `POST /api/customer/addresses` failures.
- [ ] Watch for the five unpinned customers. They can now self-fix via **Edit & drop pin**.
- [ ] Ashley Petersen (1735) has never claimed the account; she must claim/sign in before editing.
- [ ] If any unpinned customer reports a wrong fee, revisit with their exact address and a confirmed pin. Do not guess.

---

## 8. Acceptance criteria

Deployment is complete when:

1. `beluchis.service` is running commit `37432d0`.
2. Portal serves the new location UI and checkout links to `/portal`.
3. A test account can create, edit, select, and delete locations; duplicates and the cap are blocked.
4. Elda's production record remains one canonical pinned Home location.
5. No new 500 errors in service/nginx logs.
6. The five unpinned rows remain unchanged and are visibly marked "Pin needed".

---

## 9. Risks and notes

| Risk | Mitigation |
|---|---|
| Restart interrupts in-flight orders | Deploy outside trading hours; restart is quick; orders are persisted |
| Duplicate check blocks an edit on legacy duplicate rows | Production has no duplicate groups left; users can delete and re-add if needed |
| `PUT` duplicate check breaks "set default" | Already fixed: checks run only when `label`/`address` are supplied; tested |
| Unpinned customers get "unverified" fee | Known and accepted; they can pin themselves; no historical pin exists |
| Guessed pins misprice delivery | Explicit decision not to guess; customers set their own pins |

---

## 10. References

- Commit: `37432d0` — `fix: harden customer delivery locations`
- Previous production commit: `75c8d29`
- Pre-Elda-fix backup: `/var/lib/beluchis/backups/dev-pre-elda-fix-20261030-123826.db`
- Elda audit export: `/var/lib/beluchis/backups/elda-addresses-20261030-123826.json`
- API docs: `docs/API.md`
- Address code: `server/index.mjs` (customer addresses section)
- Portal UI: `public/customer.html` (`loadAddresses`)
- Checkout UI: `public/menu.html` (saved-location block)
- Unused cleanup script: `scripts/normalize-customer-addresses.mjs` — **do not run**; it is not required for this deploy
