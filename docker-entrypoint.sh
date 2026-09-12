#!/bin/sh
set -e

cd /app

# Create any missing tables (idempotent)
echo "[entrypoint] applying migrations..."
npx prisma migrate deploy

# Seed a fresh demo dataset on first boot, or whenever PREVIEW_RESEED=1
if [ ! -f /data/beluchis.db ] || [ "${PREVIEW_RESEED:-0}" = "1" ]; then
  echo "[entrypoint] seeding demo data..."
  npx prisma db seed
fi

echo "[entrypoint] starting server on :${PORT:-8080}"
exec node --env-file-if-exists=.env server/index.mjs