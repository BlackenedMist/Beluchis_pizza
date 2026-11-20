---
name: sync-new-code
description: Clean the Beluchis Pizza repo with fresh git code and update the production server. Use when old commits or a stale working tree are causing bugs, or when asked to sync/reset/deploy the project.
---

# Sync New Code

Use this skill to reset the local checkout to `origin/main` and deploy that same
code to production. Full runbook: `docs/SYNC_NEW_CODE.md`.

## Local

```bash
cd C:/Beluchis_pizza
git status --short --branch
git diff --output=C:/Users/User/AppData/Local/Temp/opencode/pre-sync-backup.patch
git fetch --all --prune
git reset --hard origin/main
git log --oneline -1
git status --short --branch
```

Never skip the backup. `git clean -fd` is OPTIONAL and destructive to untracked
files such as `printerReports/` — do not run it unless explicitly asked.

## Production

Host `ubuntu@154.65.100.89`, app `/srv/beluchis/app`, service
`beluchis.service`. Git ops must run as the `beluchis` user; DB and `.env` are
outside the repo and survive a reset.

```bash
ssh -i C:/Beluchis_pizza/id_ed25519 ubuntu@154.65.100.89
git -C /srv/beluchis/app status --short
sudo -n -u beluchis git -C /srv/beluchis/app fetch --all --prune

# Fast-forward, or reset if history was force-pushed:
git -C /srv/beluchis/app merge-base --is-ancestor HEAD origin/main && \
  sudo -n -u beluchis git -C /srv/beluchis/app pull --ff-only origin main
sudo -n -u beluchis git -C /srv/beluchis/app reset --hard origin/main

sudo systemctl restart beluchis.service        # only if server/*.mjs changed
```

Verify with `curl` on `http://127.0.0.1:3100/order`, `/shop.js`,
`/api/categories`, `/api/specials` and `https://beluchis.co.za/order` (all 200),
plus `systemctl is-active beluchis.service`.

Record the pre-reset SHA before starting so rollback is possible:
`sudo -u beluchis git -C /srv/beluchis/app reset --hard <OLD_SHA>` + restart.
