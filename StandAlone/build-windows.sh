#!/usr/bin/env bash
# Build the distributable Windows package for the Beluchis Kitchen Bridge.
#
# The package contains no binaries. On first run, fetch-node.bat downloads the
# official Node.js build from nodejs.org and checks it against the SHA256
# checksum nodejs.org publishes, so this build needs no network access and
# produces a zip of about 45 KB instead of 33 MB.
#
# The previous package shipped an unsigned nssm.exe to wrap the bridge as a
# Windows service. The bridge now runs as a native scheduled task instead,
# which needs no third-party service wrapper.
#
# Usage:  bash build-windows.sh   (run from the StandAlone directory)

set -euo pipefail
cd "$(dirname "$0")"

VERSION="1.0.1"
PKG="Beluchis-Kitchen-${VERSION}-windows-x64"
OUT="$(pwd)/dist/${PKG}.zip"
STAGE="$(mktemp -d)/${PKG}"

mkdir -p "$STAGE" "$(pwd)/dist"

# --- app files ------------------------------------------------------------
cp -r server.mjs lib public .env.example README-WINDOWS.txt package.json "$STAGE/"
cp start-kitchen.bat install-service.bat restart-service.bat stop-service.bat \
      uninstall-service.bat check-env.bat fetch-node.bat run-kitchen.cmd "$STAGE/"

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

rm -rf "$(dirname "$STAGE")"

echo "Built: $OUT"
ls -lh "$OUT"
echo
echo "Contents:"
unzip -l "$OUT"
