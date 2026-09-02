#!/usr/bin/env bash
# Full redeploy to the e-paper board: syncs source, installs deps on-device
# (native modules like `canvas` must be built for the Pi's own arch), rebuilds
# the epd_util C binary, and restarts the systemd service.
set -euo pipefail

HOST="${EPD_DEPLOY_HOST:-192.168.233.109}"
USER="${EPD_DEPLOY_USER:-root}"
REMOTE_DIR="${EPD_DEPLOY_DIR:-/home/dietpi/e-station}"
TARGET="${USER}@${HOST}"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"

echo "==> Syncing ${PROJECT_DIR}/ -> ${TARGET}:${REMOTE_DIR}/"
rsync -avz --delete \
  --exclude '.git' \
  --exclude '.idea' \
  --exclude '.DS_Store' \
  --exclude 'node_modules' \
  --exclude 'epd_util/build' \
  --exclude 'epd_update_util' \
  --exclude '*.png' \
  "$PROJECT_DIR"/ "${TARGET}:${REMOTE_DIR}/"

echo "==> Installing dependencies, rebuilding epd_util, restarting service on device"
ssh "$TARGET" "cd '${REMOTE_DIR}' && yarn install --production && bash post-deployment-script.sh"

echo "==> Deploy complete"
