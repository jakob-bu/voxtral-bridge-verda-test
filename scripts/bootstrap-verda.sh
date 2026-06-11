#!/usr/bin/env bash
set -euo pipefail

export DEBIAN_FRONTEND=noninteractive
SOURCE_URL="${VOXTRAL_SOURCE_TARBALL_URL:-https://github.com/jakob-bu/voxtral-bridge-verda-test/archive/refs/heads/main.tar.gz}"

apt-get update
apt-get install -y --no-install-recommends curl ca-certificates gnupg tar

curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
apt-get install -y --no-install-recommends nodejs

pip install --no-cache-dir -U "mistral_common>=1.9.0" soxr librosa soundfile

rm -rf /app
mkdir -p /app
curl -fsSL "${SOURCE_URL}" | tar -xz --strip-components=1 -C /app

cd /app
npm ci --omit=dev
chmod +x scripts/start-modal.sh

exec bash scripts/start-modal.sh
