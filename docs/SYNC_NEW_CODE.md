# Sync New Code — clean checkout + production update

Use this when old commits or a stale working tree are causing bugs and you want
the project reset to exactly what is on `origin/main`, then deployed to
production.

**Rule:** never run a hard reset without first saving local work. A hard reset
deletes tracked edits permanently. Untracked files survive `reset --hard` but
are deleted by `git clean -fd`.

## 1. Local project — fresh git code

```bash
cd C:/Beluchis_pizza

# 1a. See what would be lost
git status --short --branch

# 1b. Back up tracked local edits (even if you plan to discard them)
git diff --output=C:/Users/User/AppData/Local/Temp/opencode/pre-sync-backup.patch

# 1c. Fetch all remotes and prune dead refs
git fetch --all --prune

# 1d. Discard ALL tracked local changes; match origin/main exactly
git reset --hard origin/main

# 1e. Verify
git log --oneline -1
git status --short --branch
```

Optional (DESTRUCTIVE — deletes untracked files, e.g. `printerReports/`):

```bash
git clean -fd        # review with `git clean -fdn` first
```

After the reset, sanity-check the front-end:

```bash
node --check public/shop.js
npm ci               # only if package-lock.json changed in the new commits
```

## 2. Production server — fresh git code

Host: `ubuntu@154.65.100.89` (xneelo). App: `/srv/beluchis/app`.
Service: `beluchis.service`. DB and secrets live OUTSIDE the repo
(`/var/lib/beluchis/dev.db`, `/var/lib/beluchis/.env`) and are untouched by a
reset. The repo files are owned by the `beluchis` user, so run git via sudo.

```bash
ssh -i C:/Beluchis_pizza/id_ed25519 ubuntu@154.65.100.89

# 2a. Inspect before changing anything
git -C /srv/beluchis/app status --short
git -C /srv/beluchis/app log --oneline -1

# 2b. Fetch (use sudo -u beluchis: the .git dir is not writable by ubuntu)
sudo -n -u beluchis git -C /srv/beluchis/app fetch --all --prune
git -C /srv/beluchis/app log --oneline -1 origin/main

# 2c. Fast-forward if possible; if history was force-pushed, reset instead
git -C /srv/beluchis/app merge-base --is-ancestor HEAD origin/main && \
  sudo -n -u beluchis git -C /srv/beluchis/app pull --ff-only origin main
# OR, when the previous line fails (force-push / diverged history):
sudo -n -u beluchis git -C /srv/beluchis/app reset --hard origin/main

# 2d. Only when dependencies or the Prisma schema changed:
# sudo -u beluchis sh -c 'cd /srv/beluchis/app && npm ci'
# cp /var/lib/beluchis/dev.db /var/backups/beluchis-pre-sync-$(date +%F).db
# sudo -u beluchis sh -c 'cd /srv/beluchis/app && set -a && . /var/lib/beluchis/.env && set +a && npx prisma migrate deploy'

# 2e. Restart only if server/*.mjs changed (restart clears in-memory sessions)
sudo systemctl restart beluchis.service

# 2f. Verify
sudo systemctl status beluchis.service --no-pager
sudo journalctl -u beluchis.service -n 50 --no-pager
```

Smoke tests:

```bash
curl -s -o /dev/null -w 'order %{http_code}\n'      http://127.0.0.1:3100/order
curl -s -o /dev/null -w 'shop.js %{http_code}\n'    http://127.0.0.1:3100/shop.js
curl -s -o /dev/null -w 'categories %{http_code}\n' http://127.0.0.1:3100/api/categories
curl -s -o /dev/null -w 'specials %{http_code}\n'   http://127.0.0.1:3100/api/specials
curl -s -o /dev/null -w 'external %{http_code}\n'   https://beluchis.co.za/order
```

Rollback (record the old SHA from step 2a first):

```bash
sudo -u beluchis git -C /srv/beluchis/app reset --hard <OLD_SHA>
sudo systemctl restart beluchis.service
```

## 3. Current state (last run)

- Local and production synced to `origin/main`.
- `printerReports/` is untracked local data — preserved, never cleaned.
- Prod had an untracked `verifymail.mjs` — preserved by `reset --hard`.
- Kitchen/StandAlone receipt changes must be deployed separately to the Windows
  bridge; this runbook covers only the web server.
