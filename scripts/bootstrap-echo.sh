#!/usr/bin/env bash
set -euo pipefail

SOURCE_URL="${VOXTRAL_SOURCE_TARBALL_URL:-https://github.com/jakob-bu/voxtral-bridge-verda-test/archive/refs/heads/main.tar.gz}"

rm -rf /app
mkdir -p /app
curl -fsSL "${SOURCE_URL}" | tar -xz --strip-components=1 -C /app

cd /app
npm ci --omit=dev
exec node scripts/echo-server.js
