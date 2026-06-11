#!/usr/bin/env bash
set -euo pipefail

WORKDIR="${WORKDIR:-/workspace/voxtral-bridge}"
REPO_TARBALL_URL="${REPO_TARBALL_URL:-https://github.com/jakob-bu/voxtral-bridge-verda-test/archive/refs/heads/main.tar.gz}"

mkdir -p "${WORKDIR}"
cd "${WORKDIR}"

echo "[verda-bootstrap-http] fetching ${REPO_TARBALL_URL}"
curl -fsSL "${REPO_TARBALL_URL}" | tar -xz --strip-components=1

if ! command -v node >/dev/null 2>&1; then
  echo "[verda-bootstrap-http] installing Node.js"
  apt-get update
  apt-get install -y ca-certificates curl gnupg
  curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
  apt-get install -y nodejs
fi

npm ci --omit=dev
chmod +x scripts/start-verda-http.sh

exec bash scripts/start-verda-http.sh
