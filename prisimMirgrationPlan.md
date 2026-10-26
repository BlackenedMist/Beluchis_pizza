# Prisma 7 Migration Plan — Beluchis Pizza

**File:** `prisimMirgrationPlan.md`
**Status:** Draft / Planning only — NOT yet executed.
**Created:** 2026-10-24
**Revised:** 2026-10-26 (added cost/risk review, version pin, split-commit strategy)
**Owner:** Beluchis engineering
**Execution:** Local dev first (dev machine), then live via agent after local validation.
**Live target:** `ubuntu@154.65.100.89` (xneelo) — app dir `/srv/beluchis/app`, service `beluchis.service`.

---

## 0. Purpose & Scope

This document plans the upgrade of Prisma ORM from **6.19.3** to **Prisma 7 (7.2.x or newer,
verified stable on the dev machine first)**, plus the **safe patch-level vulnerability fixes**
identified during the 2026-10-24 npm audit:

- `proxy-addr` 2.0.7 → 2.0.8 (critical — IP spoofing)
- `body-parser` 1.20.8 → 1.20.9 (high — DoS)
- `qs` 6.15.3 → 6.16.1 (moderate — DoS / array-limit bypass)
- `express` 4.22.2 → 4.22.3 (moderate — via qs)
- `nodemailer` 10.0.10 → 10.2.1 (moderate — address-parser injection)

**Out of scope (deliberate):** the `deepmerge-ts` / Prisma vulnerability. Fixing it requires either
downgrading Prisma to 6.12.0 (loses 7 patch releases) or upgrading to Prisma 7.10.1+. This plan's
Prisma 7 upgrade **is** the fix for `deepmerge-ts`, so no separate action is needed.

**Not included:** Prisma 8 (release candidate) — separate, later decision.

---

## 1. Current State

| Item | Value |
|---|---|
| Prisma version | 6.19.3 (`prisma` + `@prisma/client`) |
| Node (live) | 22.23.2 (meets Prisma 7 min 20.19) |
| Node (local) | see `node --version` |
| Database | SQLite at `file:/var/lib/beluchis/dev.db` (live) / `file:./dev.db` (local) |
| Generator | `prisma-client-js` (v6 style, no `output`) |
| Datasource | `provider = "sqlite"`, `url = env("DATABASE_URL")` (v6 style) |
| Prisma usage | `new PrismaClient()` in `server/index.mjs`, `scripts/*`, `prisma/seed.ts` |
| Middleware (`$use`) | **None** — no migration needed |
| `Prisma.validator` | **None** — no migration needed |
| Migrations | 15 applied; latest `20261027120000_add_special_item_extras` |
| Runtime | ESM (`"type": "module"`); Node `--env-file-if-exists` |

### Files that must change

- `prisma/schema.prisma` — generator + datasource
- `package.json` — versions, new adapter dep, `prisma.config.ts` awareness
- **New:** `prisma.config.ts` — config moved out of schema
- `server/index.mjs` — `PrismaClient` instantiation with driver adapter
- `scripts/export-invites.mjs`, `scripts/import-wp-customers.mjs`, `scripts/seed-item-images.mjs`,
  `scripts/storefront-smoke.mjs`, `prisma/seed.ts` — same adapter change
- `.env` / `.env.example` — `DATABASE_URL` handling (see §4)

---

## 2. Target State

| Item | Value |
|---|---|
| Prisma version | 7.2.x or newer (pinned after dev validation; avoid 7.0/7.1 rough edges) |
| Generator | `prisma-client` (new Rust-free client) with explicit `output` |
| Driver adapter | `@prisma/adapter-better-sqlite3` (native, fast) |
| Config file | `prisma.config.ts` (replaces `url` in schema) |
| Datasource in schema | `provider = "sqlite"` only (no `url`) |
| Node min | 20.19 (already satisfied) |
| TypeScript min | 5.4 (verify local `tsc`/tsx) |

---

## 3. Prisma 7 Breaking Changes Relevant to This App

Source: official Prisma v7 upgrade guide + community migration reports.

1. **Generator renamed:** `prisma-client-js` → `prisma-client`. The `output` path becomes **required**
   and must point **outside** `node_modules` (e.g. `./generated/prisma`). All imports of
   `@prisma/client` must change to the generated output path.
2. **Driver adapters mandatory:** Prisma 7 no longer ships the Rust query engine for SQLite.
   A driver adapter (`@prisma/adapter-better-sqlite3`) must be passed to `new PrismaClient({ adapter })`.
3. **`datasource.url` removed from schema:** connection URL moves to `prisma.config.ts`
   (and/or `DATABASE_URL` env). Schema keeps only `provider`.
4. **Config migration:** new `prisma.config.ts` at project root; `prisma migrate`/`generate` read from it.
   Need `import 'dotenv/config'` (or rely on `--env-file`) in both config and app entry.
5. **Seeding:** `prisma migrate dev` no longer auto-runs seed in v7. Seed must be invoked
   explicitly (`npx prisma db seed` / `npm run db:seed`). Current scripts already call it explicitly —
   verify and document.
6. **Client middleware removed:** `$use` is gone → Client Extensions. **Not used here** — no work.
7. **`Prisma.validator` deprecated** → `satisfies`. **Not used here** — no work.
8. **CLI flag removals:** some `prisma migrate`/`db execute` flags removed. Our commands use
   `migrate deploy` and `db seed` only — unaffected.
9. **Environment variable changes:** several Prisma env vars removed/renamed. Review `DATABASE_URL`
   usage; keep as-is (still supported via config).
10. **Mapped enums:** reverted to v6 behavior — no change for us.
11. **MongoDB:** not supported in v7 — irrelevant (we use SQLite).
12. **Query timeout:** new default 15s per query (community report). Monitor for slow queries;
    may need to raise for large catalog operations.
13. **Rust engine gone:** smaller bundles, faster cold start; native `better-sqlite3` requires
    build toolchain on the server (`python3`, `make`, `g++`).

---

## 4. Environment / Configuration Changes

### 4.1 `prisma/schema.prisma`

```prisma
generator client {
  provider = "prisma-client"
  output   = "../generated/prisma"   // outside node_modules
}

datasource db {
  provider = "sqlite"
  // url removed
}
```

### 4.2 New `prisma.config.ts` (project root)

```ts
import "dotenv/config";
import { defineConfig, env } from "prisma/config";

export default defineConfig({
  schema: "prisma/schema.prisma",
  migrations: { path: "prisma/migrations" },
  datasource: { url: env("DATABASE_URL") },
});
```

### 4.3 `package.json`

- Bump `prisma` and `@prisma/client` to `^7.2.0` (pinned after dev validation).
- Add dependency: `@prisma/adapter-better-sqlite3` (version matching Prisma 7).
- Add dependency: `better-sqlite3` (peer of the adapter).
- Keep `tsx`, `@types/*` as needed.
- `postinstall` still runs `prisma generate` (verify it picks up new config).
- **Verify `generated/` is gitignored** before committing; regenerate via `postinstall` in CI/deploy.

### 4.4 `.env` / `.env.example`

- `DATABASE_URL` unchanged (`file:/var/lib/beluchis/dev.db` live, `file:./dev.db` local).
- Add note that `prisma.config.ts` reads it; app reads `process.env.DATABASE_URL` indirectly via Prisma.
- Live `.env` at `/var/lib/beluchis/.env` — **do not overwrite** during migration; only add vars if needed.

### 4.5 Server code (`server/index.mjs`)

```js
import { PrismaClient } from "../generated/prisma/index.js"; // or generated path
import { PrismaBetterSqlite3 } from "@prisma/adapter-better-sqlite3";
const adapter = new PrismaBetterSqlite3({ url: process.env.DATABASE_URL });
const prisma = new PrismaClient({ adapter });
```

Same pattern in `scripts/*` and `prisma/seed.ts`.

### 4.6 Build toolchain on live server

Install before migration:

```bash
sudo apt install -y build-essential python3
```

(`better-sqlite3` needs native compile; Node 22 ABI must match.)

---

## 5. Safe Vulnerability Patches (Commit A — do FIRST, separate commit)

Apply **before** the Prisma migration. Separate commit so each change is independently
rollback-able. This is the immediate security win (incl. critical `proxy-addr`).

```bash
npm install express@^4.22.3 body-parser@^1.20.9 qs@^6.16.1 proxy-addr@^2.0.8 nodemailer@^10.2.1
npm audit  # verify the 5 request-path vulns cleared
```

**Note:** `npm audit fix` would also downgrade Prisma to 6.12.0 — **do NOT run bare `npm audit fix`**.
Use targeted installs above. The `deepmerge-ts` vuln clears automatically once Prisma 7 lands.

---

## 6. Migration Steps (Local Dev First)

Run on the local dev machine (`C:\Beluchis_pizza`). Do **not** touch live until §7 passes.

### 6.1 Prepare

```bash
cd C:\Beluchis_pizza
git tag v6-pre-prisma7   # bookmark v6 state for rollback
git checkout -b prisma-7-migration
git status   # must be clean
node --version   # >= 20.19
npx tsc --version # >= 5.4 (if installed)
# Back up the v6 lockfile for rollback safety:
cp package-lock.json package-lock.v6.json
```

### 6.2 Back up local DB + restore dry-run

```bash
cp prisma/dev.db prisma/dev.db.pre-prisma7  # or wherever local DB lives
# Restore dry-run (verify backup is usable):
cp prisma/dev.db.pre-prisma7 /tmp/dev.db.restore-test && echo "restore OK"
```

### 6.3 Apply code changes (§3/§4)

1. Update `prisma/schema.prisma` generator + datasource.
2. Create `prisma.config.ts`.
3. Update `package.json` (versions + adapter deps).
4. Update imports + `PrismaClient` instantiation in `server/index.mjs`, `scripts/*`, `prisma/seed.ts`.
5. Update `.env.example` if needed.

### 6.4 Install & generate

```bash
npm install
npx prisma generate
```

Verify `generated/prisma` is created and imports resolve.

### 6.5 Migrate (dev)

```bash
npx prisma migrate dev --name prisma7_upgrade
```

This creates a migration capturing any schema changes Prisma 7 requires. Review the generated SQL before applying.

### 6.6 Seed

```bash
npm run db:seed
```

### 6.7 Smoke tests (local)

```bash
npm run start
# in another shell:
curl -s http://127.0.0.1:3100/api/categories
curl -s http://127.0.0.1:3100/api/specials
# exercise admin login, customer login, place a test order, PayGate sandbox if available
npm run storefront-smoke
npm run ui-smoke
```

### 6.8 Full regression

- Admin login / orders board
- Customer login + order history + event timeline
- Menu rendering + images
- Checkout + COD + PayGate (sandbox)
- Kitchen bridge poll (if running locally)
- Email sending (nodemailer patched version)

### 6.9 Commit (local branch — Commit B)

```bash
git add -A
git commit -m "feat: migrate to Prisma 7 (driver adapter, generated client, config)"
```

Do **not** merge to `main` until live execution (§7) is scheduled and Commit A is stable.

---

## 7. Live Execution Plan (future date, after local validation)

> **Gate:** only proceed after §6.8 passes on the dev machine and user approves.

### 7.1 Pre-flight on live

```bash
ssh ubuntu@154.65.100.89
sudo apt install -y build-essential python3   # if not present
sudo -u beluchis node --version   # >= 20.19
```

### 7.2 Backup

```bash
sudo -u beluchis cp /var/lib/beluchis/dev.db /var/lib/beluchis/backups/dev.db.pre-prisma7
sudo -u beluchis cp /var/lib/beluchis/.env /var/lib/beluchis/backups/env.pre-prisma7
```

### 7.3 Deploy (maintenance window)

```bash
sudo systemctl stop beluchis
sudo -u beluchis git -C /srv/beluchis/app fetch --all
sudo -u beluchis git -C /srv/beluchis/app checkout prisma-7-migration  # or merge to main first
sudo -u beluchis sh -c 'cd /srv/beluchis/app && npm ci'
sudo -u beluchis sh -c 'cd /srv/beluchis/app && set -a && . /var/lib/beluchis/.env && set +a && npx prisma migrate deploy'
sudo -u beluchis sh -c 'cd /srv/beluchis/app && set -a && . /var/lib/beluchis/.env && set +a && npm run db:seed'  # if seed needed
sudo systemctl start beluchis
```

### 7.4 Smoke (live)

```bash
curl -s -o /dev/null -w "%{http_code}\n" http://127.0.0.1:3100/api/categories
curl -s -o /dev/null -w "%{http_code}\n" http://127.0.0.1:3100/api/specials
curl -s -o /dev/null -w "%{http_code}\n" http://127.0.0.1:3100/preview/mobile
curl -fsS https://beluchis.co.za/api/categories -o /dev/null -w "%{http_code}\n"
sudo journalctl -u beluchis -n 30 --no-pager
```

### 7.5 Merge to main (after live validation)

```bash
# locally
git checkout main
git merge --no-ff prisma-7-migration
git push origin main
# on live: git -C /srv/beluchis/app checkout main && git pull
```

---

## 8. Rollback Plan

If anything fails during live execution:

```bash
sudo systemctl stop beluchis
sudo -u beluchis git -C /srv/beluchis/app reset --hard f981e54   # pre-migration SHA (adjust to last good)
# or: git reset --hard c58ac94 (current live) if migration commit not yet merged
sudo -u beluchis sh -c 'cd /srv/beluchis/app && npm ci'   # reinstall v6 deps
sudo -u beluchis cp /var/lib/beluchis/backups/dev.db.pre-prisma7 /var/lib/beluchis/dev.db
sudo systemctl start beluchis
```

**Note:** `npm ci` after rollback restores v6 `node_modules` from the v6 `package-lock.json`.
Keep the pre-migration `package-lock.json` committed or backed up before migration.

Database rollback is safe because the migration in §6.5 only adds a migration record + possibly
schema changes; restoring the backup DB reverts data. Schema changes from Prisma 7 (if any)
are captured in the migration and can be reverted with `prisma migrate resolve` if needed.

---

## 9. Implementation Costs

### 9.1 Developer time (realistic, solo dev)

| Phase | Estimate |
|---|---|
| Commit A — vulnerability patches + re-test | 1–2 h |
| Commit B — code changes (generator, config, imports, adapter) | 4–8 h |
| Local testing (smoke, regression, orders, payments) | 4–8 h |
| Debugging generated-client import paths / ESM issues | 2–6 h (common pain point) |
| Live pre-flight + execution (maintenance window) | 1–2 h |
| Post-deploy monitoring + hotfixes | 2–4 h |
| **Total** | **~2–4 working days** |

### 9.2 Infrastructure / money

- **No new servers or licenses** — existing xneelo VM suffices.
- **Build toolchain:** `apt install build-essential python3` — free, minutes.
- **better-sqlite3 native compile:** needs RAM during build; 2 vCPU/4 GB tier is fine.
- **Rollback safety net:** backup DB (~1 MB) — negligible disk.

### 9.3 Downtime

- **Maintenance window:** 5–15 min (`stop → reset → npm ci → migrate deploy → start`).
- `npm ci` on live ~7–11 s (observed); `migrate deploy` <1 s; dominated by restart + smoke.
- **No zero-downtime path** in this plan — acceptable per stated tolerance.

### 9.4 Coordination cost

- Dev machine is elsewhere; live execution is gated on your local validation + approval.
- Add ~1 day of calendar latency for the handoff.

---

## 10. Risk Factors

### 10.1 Technical risks

| # | Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|---|
| R1 | Native `better-sqlite3` fails to compile on live | Medium | High | Install `build-essential`+`python3` first; test on dev with same Node ABI (22.23.2) |
| R2 | Generated-client import paths break scripts (miss one of 6 files) | Medium | Medium | Update all 6; run `storefront-smoke`/`ui-smoke`; grep for `@prisma/client` after |
| R3 | `prisma migrate dev` generates unexpected SQL (schema drift) | Low | High | Review generated migration; dry-run on local first |
| R4 | Prisma 7 default 15 s query timeout breaks slow ops | Low | Medium | Monitor logs; raise via client config if needed |
| R5 | Seeding not auto-run in v7 — forgotten seed leaves stale demo data | Medium | Low | Explicit seed step; recommend skipping seed on live |
| R6 | Community-reported rough edges in Prisma 7.0/7.1 | Medium | Medium | Pin to 7.2+ (done in §2/§4.3); validate on dev first |
| R7 | Bare `npm audit fix` downgrades Prisma to 6.12.0 | Medium | High | Plan forbids it; targeted installs only (§5) |
| R8 | Rollback `npm ci` needs v6 `package-lock.json` | Medium | High | Keep v6 lockfile backed up (§6.1 tag + `package-lock.v6.json`) |
| R9 | Env/config loading fails in v7 (`prisma.config.ts`) | Low | High | Test config load locally first; verify `migrate status` |

### 10.2 Operational risks

| # | Risk | Mitigation |
|---|---|---|
| R10 | Downtime during maintenance window | Acceptable per tolerance; keep window 5–15 min |
| R11 | Backup never restored/tested | Add restore dry-run in §6.2 (done) |
| R12 | Kitchen bridge polling delays if app down >30 min | Schedule window; accept overnight 30-min cadence |
| R13 | PayGate notify missed during downtime | Keep window short; PayGate retries; check `journalctl` after |

### 10.3 Security risks

| # | Risk | Mitigation |
|---|---|---|
| R14 | 8 npm vulnerabilities remain until migration + §5 land | Apply §5 (Commit A) first — immediate security win |
| R15 | Critical `proxy-addr` (IP spoofing) with nginx in front | Patch proxy-addr first, independent of Prisma |

---

## 11. Open Questions / Decisions Needed Before Execution

1. **Prisma exact version** — pin to 7.2.x+ (updated from "latest stable 7.x").
2. **Seed on live?** — recommend skip seed on live; only `migrate deploy`.
3. **Generated client location** — confirm `./generated/prisma` is gitignored; regenerate via `postinstall`.
4. **Vuln patches timing** — Commit A (§5) first, then Commit B (Prisma 7). Independently rollback-able.
5. **Staging** — user has local dev instance elsewhere; validate there first.
6. **Execution date** — TBD; agent runs live steps after local validation.
7. **Backup tag** — create `v6-pre-prisma7` tag + `package-lock.v6.json` before migration (§6.1).

---

## 12. References

- Prisma v7 upgrade guide: https://www.prisma.io/docs/guides/upgrade-prisma-orm/v7
- Prisma v7 migration community guides (driver adapters, prisma.config.ts, output path)
- Project `deploy.md` §B (xneelo production playbook)
- Project `SESSION-HANDOVER.md`, `update_precheck.md`
- npm audit output (2026-10-24): 8 vulnerabilities (3 moderate, 4 high, 1 critical)

---

**End of plan.** No changes have been made to code or live systems by this document.