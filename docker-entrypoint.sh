#!/bin/sh
set -e

cd /app

# 1. Force ensure the data directory exists and is writeable
mkdir -p /data

# 2. Create any missing tables (idempotent)
echo "[entrypoint] applying migrations..."
npx prisma migrate deploy

# 3. Seed demo data safely
# If the DB doesn't exist, we must seed it. 
# If PREVIEW_RESEED=1 is set, only seed if we can wipe or handle it safely.
if [ ! -f /data/beluchis.db ]; then
  echo "[entrypoint] Initial boot: seeding demo data..."
  npx prisma db seed
elif [ "${PREVIEW_RESEED:-0}" = "1" ]; then
  echo "[entrypoint] Reseed requested: Running seed sequence..."
  # Catching errors here prevents a bad seed script from crashing the entire app boot sequence
  npx prisma db seed || echo "[entrypoint] Warning: Seeding encountered constraint conflicts, continuing boot..."
fi

echo "[entrypoint] starting server on :${PORT:-8080}"
exec node --env-file-if-exists=.env server/index.mjs

