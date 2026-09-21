#!/usr/bin/env bash
# Build the distributable Windows package for the Beluchis Kitchen Bridge.
# Downloads the official Node.js Windows binaries + NSSM service wrapper,
# assembles a clean standalone folder, and zips it to dist/.
#
# The binaries are never committed to the repo - they are cached under
# ~/.cache/beluchis-win-build and only used inside the built zip.
#
# Usage:  bash build-windows.sh   (run from the StandAlone directory)

set -euo pipefail
cd "$(dirname "$0")"

VERSION="1.0.0"
NODE_V="22.23.2"
NSSM_ZIP_NAME="nssm-2.24-101-g897c7ad.zip"
NSSM_DIR="nssm-2.24-101-g897c7ad"
PKG="Beluchis-Kitchen-${VERSION}-windows-x64"
CACHE="${XDG_CACHE_HOME:-$HOME/.cache}/beluchis-win-build"
OUT="$(pwd)/dist/${PKG}.zip"
STAGE="$(mktemp -d)/${PKG}"

mkdir -p "$STAGE/bin" "$CACHE" "$(pwd)/dist"

# --- node.exe -------------------------------------------------------------
NODE_ZIP="${CACHE}/node-v${NODE_V}-win-x64.zip"
if [ ! -f "$NODE_ZIP" ]; then
  echo "Downloading Node ${NODE_V} (win-x64)..."
  curl -sSL -o "$NODE_ZIP" "https://nodejs.org/dist/v${NODE_V}/node-v${NODE_V}-win-x64.zip"
fi
unzip -p "$NODE_ZIP" "node-v${NODE_V}-win-x64/node.exe" > "$STAGE/bin/node.exe"

# --- nssm.exe -------------------------------------------------------------
NSSM_ZIP="${CACHE}/${NSSM_ZIP_NAME}"
if [ ! -f "$NSSM_ZIP" ]; then
  echo "Downloading NSSM..."
  curl -sSL -o "$NSSM_ZIP" "https://nssm.cc/ci/${NSSM_ZIP_NAME}"
fi
unzip -p "$NSSM_ZIP" "${NSSM_DIR}/win64/nssm.exe" > "$STAGE/bin/nssm.exe"

# --- app files ------------------------------------------------------------
cp -r server.mjs lib public .env.example README-WINDOWS.txt package.json "$STAGE/"
cp start-kitchen.bat install-service.bat restart-service.bat stop-service.bat uninstall-service.bat check-env.bat "$STAGE/"

# --- zip ------------------------------------------------------------------
(
  cd "$(dirname "$STAGE")"
  if command -v zip >/dev/null 2>&1; then
    zip -qr "$OUT" "$PKG"
  else
    python3 - "$OUT" "$PKG" <<'PY'
import sys, zipfile, os
out, pkg = sys.argv[1], sys.argv[2]
with zipfile.ZipFile(out, "w", zipfile.ZIP_DEFLATED) as z:
    for root, dirs, files in os.walk(pkg):
        for f in files:
            p = os.path.join(root, f)
            z.write(p, p)
PY
  fi
)

echo "Built: $OUT"
ls -lh "$OUT"
echo
echo "Contents:"
unzip -l "$OUT" | head -25