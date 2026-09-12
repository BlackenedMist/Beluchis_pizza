# Beluchis — Deployment & Hosting Playbook

Current goal:
- **Preview / display:** IBM Cloud **Code Engine** (serverless, near-zero cost) in region **eu-gb (London)**, resource group **Turbomonics**.
- **Production:** **xneelo Cloud** VM (not purchased yet — see Part B "what to buy").

> 🔧 **Replace placeholders before running:** `YOUR-DOMAIN`, `beluchis-preview`, `PREVIEW_ADMIN_PIN`, `PROD_ADMIN_PIN`, `PROD_PAYGATE_ID`, `PROD_PAYGATE_KEY`.

---

## 0. Locked decisions

| Topic | Decision |
|---|---|
| Preview platform | IBM Cloud Code Engine (`eu-gb`, resource group `Turbomonics`) |
| Production platform | xneelo Cloud (IaaS VM) |
| Database | SQLite keeps working (single VM / single process). Migrate to Postgres only if needed later |
| Domain | Owned by us; hostnames below are placeholders until agreed |
| Demo data | Re-seeded at boot (Code Engine: ephemeral filesystem) |

## 1. App facts

- Runtime: **Node 22+**, Express, Prisma ORM + SQLite.
- Server entry: `server/index.mjs`, listens on `PORT` (default 3100; **8080** in containers).
- Front-ends: static HTML in `public/` (home, menu, login, admin, customer, `/preview/*`).
- Sessions: **in-memory** (cookies `beluchis_admin`, `beluchis_customer`) → **must run single instance** (`min-scale=max-scale=1` on Code Engine).
- Payments: PayGate. Webhook endpoints `POST/GET /paygate/return` (+ `/paygate/notify`) must be reachable over **public HTTPS**.
- DB bootstrap: `prisma migrate deploy` at boot; demo `prisma db seed` on first boot / `PREVIEW_RESEED=1`.
- Menu source: `catalog/` (committed; 5 JSON files, ~104 KB) — read by `prisma/seed.ts`.

### Environment variables

| Var | Preview (CE) | Production (xneelo) |
|---|---|---|
| `PORT` | `8080` | `3100` |
| `DATABASE_URL` | `file:/data/beluchis.db` (ephemeral) | `file:/var/lib/beluchis/dev.db` |
| `ADMIN_PIN` | `PREVIEW_ADMIN_PIN` | `PROD_ADMIN_PIN` |
| `PUBLIC_BASE_URL` | `https://beluchis-preview.<hash>.eu-gb.codeengine.appdomain.cloud` | `https://YOUR-DOMAIN` |
| `PAYGATE_ID` | *(empty for preview)* | `PROD_PAYGATE_ID` |
| `PAYGATE_KEY` | *(empty for preview)* | `PROD_PAYGATE_KEY` |
| `PREVIEW_RESEED` | `1` | unset |

---

## 2. Local prerequisites (already done on this machine)

- `ibmcloud` CLI 2.46 + `code-engine` plug-in 1.63.1 — login: `ibmcloud login --apikey <key>`; target: `ibmcloud target -g Turbomonics -r eu-gb` (key lives at `/mnt/hybrid-apps/configs/ibm/api-key.txt`, mode 600).
- Docker (daemon up) for local image verification.
- SSH deploy key `~/.ssh/id_ed25519` (**public** key → paste into xneelo).
- `gh` 2.100 at `~/bin/gh` for GitHub auth (`gh auth login` first time).

---

## Part A — IBM Cloud Code Engine (preview)

### A1. One-time CLI login
```bash
ibmcloud login --apikey "$(cat /mnt/hybrid-apps/configs/ibm/api-key.txt)"
ibmcloud target -g Turbomonics -r eu-gb
```

### A2. Create the Code Engine project
```bash
ibmcloud ce project create --name beluchis-preview-proj
ibmcloud ce project select --name beluchis-preview-proj
```

### A3. Build & deploy from GitHub (Dockerfile strategy)
Repo: `https://github.com/BlackenedMist/Beluchis_pizza` (public — no repo credentials needed).

```bash
ibmcloud ce app create \
  --name beluchis-preview \
  --build-source https://github.com/BlackenedMist/Beluchis_pizza.git \
  --strategy dockerfile \
  --port 8080 \
  --cpu 0.5 --memory 1G \
  --min-scale 1 --max-scale 1 \
  --env PORT=8080 \
  --env DATABASE_URL=file:/data/beluchis.db \
  --env ADMIN_PIN=PREVIEW_ADMIN_PIN \
  --env PREVIEW_RESEED=1
```

Code Engine auto-provisions a private Container Registry namespace on the first build
(eu-gb pushes to `uk.icr.io`). If a registry secret is requested, create:
`ibmcloud ce registry create --name icr --server uk.icr.io --username iamapikey --password "$(cat /mnt/hybrid-apps/configs/ibm/api-key.txt)"`

### A4. Point `PUBLIC_BASE_URL` at the real app URL
Build status: `ibmcloud ce app show --name beluchis-preview`. When status is **Ready**, the app URL is
`https://beluchis-preview.<hash>.eu-gb.codeengine.appdomain.cloud`. Set it:

```bash
ibmcloud ce app update --name beluchis-preview \
  --env PUBLIC_BASE_URL=https://beluchis-preview.<hash>.eu-gb.codeengine.appdomain.cloud
```

### A5. Behavior notes
- Filesystem is **ephemeral** + scale-to-zero: each cold start re-migrates + re-seeds the demo DB
  (`/data/beluchis.db`). Fine for a display preview; NOT for persistence.
- `min-scale 1 / max-scale 1` keeps in-memory sessions valid and avoids Postgres-like cold-hit gaps.
- Demo logins after boot: Zanele `+27 60 555 0000` / `beluchis123`; admin pin = `ADMIN_PIN`.

### A6. Verify
```bash
curl -I https://beluchis-preview.<hash>.eu-gb.codeengine.appdomain.cloud/preview/mobile   # 200
curl -I https://beluchis-preview.<hash>.eu-gb.codeengine.appdomain.cloud/preview/portal  # 200
curl -s  https://beluchis-preview.<hash>.eu-gb.codeengine.appdomain.cloud/api/specials  # coupon list
```

### A7. Optional: map a custom subdomain (e.g. `preview.YOUR-DOMAIN`)
1. DNS: CNAME `preview.YOUR-DOMAIN` → `beluchis-preview.<hash>.eu-gb.codeengine.appdomain.cloud`.
2. Map + TLS (needs an IBM-provided certificate, typically via Cloud Internet Services, or use the
   Code Engine console "Domain Mappings" with a `.appdomain.cloud` intermediate).
3. Update `PUBLIC_BASE_URL` to `https://preview.YOUR-DOMAIN`.

### A8. Cost & teardown
- Code Engine free allowance usually covers a tiny preview app; worst-case a few $/month (0.5 CPU / 1 GB, 1 instance).
- Remove: `ibmcloud ce app delete --name beluchis-preview`; `ibmcloud ce project delete --name beluchis-preview-proj`.

---

## Part B — xneelo Cloud (production)

### B1. What to buy
Shared **Web Hosting** and **Managed Servers** are **LAMP-only (no Node)** — do NOT buy those.
Buy instead (https://www.xneelo.co.za/servers/):
- **xneelo Cloud** IaaS VM — smallest tier that fits a Node app (e.g. 2 vCPU / 4 GB), Ubuntu **LTS (22.04 / 24.04)** image, Johannesburg datacenter.
- **Block volume** for persistence (mount `/var/lib/beluchis`; SQLite lives there).
- **Floating IP** to keep a fixed public address.

### B2. DNS
Point your domain at the VM:
- Add an **A record**: `YOUR-DOMAIN` → floating IP (and optionally `www` → same IP).
- Give DNS ~5–60 min to propagate: `dig +short YOUR-DOMAIN` should return the floating IP.

### B3. First-boot hardening
```bash
# as root / sudo
apt update && apt upgrade -y
useradd -m -s /bin/bash beluchis
usermod -aG sudo beluchis
mkdir -p /home/beluchis/.ssh && cp /root/.ssh/authorized_keys /home/beluchis/.ssh/ 2>/dev/null || true
# paste our public key (ssh-ed25519 AAAAC3…RU84 beluchis-deploy) here
echo 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIF0eK6NQfYQqxZX1CM0Yzvyvbcxc0jherk20JkMPRU84 beluchis-deploy' >> /home/beluchis/.ssh/authorized_keys
chown -R beluchis:beluchis /home/beluchis/.ssh && chmod 700 /home/beluchis/.ssh && chmod 600 /home/beluchis/.ssh/authorized_keys
# disable root password login
sed -i 's/^#\?PermitRootLogin.*/PermitRootLogin prohibit-password/' /etc/ssh/sshd_config
systemctl restart ssh
ufw allow OpenSSH && ufw allow 'Nginx HTTPS' && ufw allow 'Nginx HTTP' && ufw --force enable
```

### B4. Runtime install
```bash
sudo apt install -y nginx certbot python3-certbot-nginx git
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash - && sudo apt install -y nodejs
node -v   # >= 22
```

### B5. Deploy the app
```bash
sudo mkdir -p /opt/beluchis /var/lib/beluchis
sudo chown -R beluchis:beluchis /opt/beluchis /var/lib/beluchis
sudo -u beluchis git clone https://github.com/BlackenedMist/Beluchis_pizza.git /opt/beluchis
cd /opt/beluchis
sudo -u beluchis npm ci
sudo -u beluchis npx prisma migrate deploy
sudo -u beluchis npx prisma db seed        # only first time
# environment
sudo -u beluchis sh -c 'cat > /opt/beluchis/.env <<EOF
PORT=3100
DATABASE_URL=file:/var/lib/beluchis/dev.db
ADMIN_PIN=PROD_ADMIN_PIN
PAYGATE_ID=PROD_PAYGATE_ID
PAYGATE_KEY=PROD_PAYGATE_KEY
PUBLIC_BASE_URL=https://YOUR-DOMAIN
EOF'
sudo chmod 600 /opt/beluchis/.env
```
Jenkins/CI: repeat with a pull, `npm ci`, `npx prisma migrate deploy`.

### B6. systemd service — `/etc/systemd/system/beluchis.service`
```ini
[Unit]
Description=Beluchis server
After=network.target

[Service]
User=beluchis
WorkingDirectory=/opt/beluchis
ExecStart=/usr/bin/env node --env-file-if-exists=/opt/beluchis/.env server/index.mjs
Restart=on-failure
RestartSec=3

[Install]
WantedBy=multi-user.target
```
```bash
sudo systemctl daemon-reload
sudo systemctl enable --now beluchis
systemctl status beluchis
```

### B7. nginx reverse proxy + TLS
`/etc/nginx/sites-available/beluchis`:
```nginx
server {
  listen 80;
  server_name YOUR-DOMAIN;
  location / {
    proxy_pass http://127.0.0.1:3100;
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header X-Forwarded-Proto $scheme;
  }
}
```
```bash
sudo ln -s /etc/nginx/sites-available/beluchis /etc/nginx/sites-enabled/
sudo nginx -t && sudo systemctl reload nginx
sudo certbot --nginx -d YOUR-DOMAIN          # obtains HTTPS + auto-renews
```

### B8. PayGate configuration
In the PayGate merchant portal, set the **return/notify URLs** to:
- `https://YOUR-DOMAIN/paygate/return`
- `https://YOUR-DOMAIN/paygate/notify`

Set `PAYGATE_ID` / `PAYGATE_KEY` in `/opt/beluchis/.env` and restart `beluchis`.

### B9. Nightly backup (SQLite file copy)
`/etc/cron.d/beluchis-backup` (or a systemd timer):
```
15 2 * * * beluchis  cp /var/lib/beluchis/dev.db /var/backups/beluchis-$(date +\%F).db && find /var/backups -name 'beluchis-*.db' -mtime +14 -delete
```
Test a restore: stop the app, copy the backup back over `dev.db`, restart, run a smoke test.

### B10. Deploy / rollback snippet (`deploy.sh`)
```bash
#!/usr/bin/env bash
set -euo pipefail
cd /opt/beluchis
git fetch --all && git reset --hard origin/main
npm ci
npx prisma migrate deploy
sudo systemctl restart beluchis
curl -fsS http://127.0.0.1:3100/api/categories >/dev/null && echo "OK"
```
Rollback: `git reset --hard <previous-sha>` + restart.

### B11. Production smoke test
```bash
curl -fsS  https://YOUR-DOMAIN/preview/mobile   -o /dev/null -w "%{http_code}\n"     # 200
curl -fsS  https://YOUR-DOMAIN/api/categories  -o /dev/null -w "%{http_code}\n"     # 200
curl -fsS  https://YOUR-DOMAIN/api/specials      -o /dev/null -w "%{http_code}\n"     # 200
```
Browser: place an order → PayGate test payment → confirm `OrderStatusEvent` timeline inside the portal.

---

## 9. Shared smoke-test checklist
- [ ] `/preview/mobile` and `/preview/portal` render and auto-login (demo cookie set).
- [ ] `/api/categories`, `/api/specials` return 200.
- [ ] Customer login with Zanele (`+27 60 555 0000` / `beluchis123`) → order history shows event timelines.
- [ ] Admin login with `ADMIN_PIN` works.
- [ ] PayGate return → order marked paid → timeline updated.

## 10. Go-live hardening checklist
- [ ] Use real `PAYGATE_ID/KEY`, real domain, tested `PUBLIC_BASE_URL`.
- [ ] Strong `ADMIN_PIN`, rotate if it ever appeared in chat/logs.
- [ ] Make GitHub repo **private** → Code Engine builds then need a repo-write secret (fine-grained PAT) in the project; xneelo deploys use SSH deploy key or a dedicated PAT.
- [ ] Backups restored once in a dry-run.
- [ ] Rate-limit + review auth cookies + session TTL in `server/index.mjs` before public launch.
- [ ] Rotate the IBM API key after deployment if it was shared in chat.