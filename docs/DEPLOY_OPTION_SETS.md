# Deploy: generic option sets + address form updates

Date: 2026-11-25
Target: xneelo `ubuntu@154.65.100.89`, app `/srv/beluchis/app`, service `beluchis.service`
Pre-deploy production SHA: `41f6ac8967b6678acad7e296f1c2afad9df93994`

## Scope

- Generic **Option sets** replace the Bases / Pasta Types admin UI (legacy tables/APIs stay).
- New Prisma migration `20261125120000_add_option_sets` + one-off data import.
- Server: `/api/option-sets` CRUD, `optionSetIds` on items, `optionValueIds` repricing/validation on quotes and orders.
- Storefront: option-set dropdowns, cart reconciliation, address wizard copy + street-number field, single-confirmation address flow.
- Admin: Option sets tab and "+ New option set" shortcut in the item editor.

## Preflight

1. `git status --short` locally — only intended files, no `WhatsApp Image …` screenshot.
2. `git fetch origin` — rebase if origin moved.
3. Production: record SHA, `git status --short`, `systemctl is-active beluchis.service`, `prisma migrate status`.
4. **Back up the production DB** before any change:
   `sudo cp /var/lib/beluchis/dev.db /var/backups/beluchis-pre-optionsets-$(date +%F).db`

## Execute

Local:

```bash
git add <all intended files>
git commit -m "feat: generic option sets for menu items"
git push origin main
```

Production (over SSH):

```bash
git -C /srv/beluchis/app status --short                      # expect only verifymail.mjs
sudo -n -u beluchis git -C /srv/beluchis/app fetch --all --prune
git -C /srv/beluchis/app merge-base --is-ancestor HEAD origin/main \
  && sudo -n -u beluchis git -C /srv/beluchis/app pull --ff-only origin main
```

Then, **still on the old running process** (so no request sees new code without new tables):

```bash
sudo -u beluchis sh -c 'cd /srv/beluchis/app && set -a && . /var/lib/beluchis/.env && set +a && npx prisma migrate deploy'
sudo -u beluchis sh -c 'cd /srv/beluchis/app && set -a && . /var/lib/beluchis/.env && set +a && npx prisma generate'
sudo -u beluchis sh -c 'cd /srv/beluchis/app && set -a && . /var/lib/beluchis/.env && set +a && npm run option-sets:import'
```

`npm ci` is **not** needed: only a package.json script changed, no dependencies.

Restart to load the new server code (this logs customers out):

```bash
sudo systemctl restart beluchis.service
```

## Verify

1. `systemctl is-active beluchis.service` → `active`; journal has no new errors.
2. HTTP 200: `http://127.0.0.1:3100/order`, `/shop.js`, `/api/categories`, `/api/specials`, `/api/option-sets`, and `https://beluchis.co.za/order`.
3. `GET /api/option-sets` returns size-labelled `Base` sets (and `Pasta type` sets) with values carrying legacy ids.
4. `GET /api/items` returns `optionSets` on items that had bases/pasta types.
5. Quote-only smoke test (`POST /api/orders` with `quote:true`) using a real `optionValueId`, with a bogus client price — the returned extra price must come from the DB. Also check a bogus value id is rejected with 400. **No real orders.**
6. Served assets contain new strings: `grep -c "street name only" /srv/beluchis/app/public/assets/beluchis-delivery.js`.
7. Served files match the pushed SHA: `git -C /srv/beluchis/app rev-parse HEAD`.

## Rollback

- Code: `sudo -u beluchis git -C /srv/beluchis/app reset --hard 41f6ac8967b6678acad7e296f1c2afad9df93994 && sudo systemctl restart beluchis.service`
- DB (only if the new tables/import caused a problem): restore the backup taken in preflight.
- The old server code ignores the extra tables, so a code-only rollback is safe without dropping tables.
