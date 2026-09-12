#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")"

echo "== Beluchis preview installer =="

command -v node >/dev/null 2>&1 || { echo "Node.js is required (>= 18)."; exit 1; }
node -e "process.exit(Number(process.versions.node.split('.')[0]) < 18 ? 1 : 0)" || { echo "Node.js >= 18 is required."; exit 1; }

if [ ! -d node_modules ]; then
  echo "Installing dependencies (npm install)…"
  npm install
else
  echo "node_modules present — skipping install."
fi

if [ ! -f .env ]; then
  cp .env.example .env
  echo "Created .env from .env.example (ADMIN_PIN default '1234')."
fi

echo
echo "Ready. Start with:"
echo "  ./start.sh"
echo "  Menu  : http://localhost:3100/"
echo "  Admin : http://localhost:3100/admin   (login: blank username or 'admin' + PIN from .env)"