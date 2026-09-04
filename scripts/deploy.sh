#!/usr/bin/env bash
# Full redeploy to the e-paper board: builds the editor bundle locally, syncs
# source, installs deps on-device (native modules like `canvas` must be built
# for the Pi's own arch), rebuilds the epd_util C binary, and restarts the
# systemd service.
#
# The server is *not* built: the Pi runs Node 24, which strips TypeScript
# types natively, so `node server.ts` is the production entry point. Only the
# browser client is bundled, and only the bundle ships - client/ sources are
# excluded below.
set -euo pipefail

HOST="${EPD_DEPLOY_HOST:-192.168.233.109}"
USER="${EPD_DEPLOY_USER:-root}"
REMOTE_DIR="${EPD_DEPLOY_DIR:-/home/dietpi/e-station}"
TARGET="${USER}@${HOST}"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"

echo "==> Type checking"
(cd "$PROJECT_DIR" && yarn typecheck)

echo "==> Building editor bundle"
(cd "$PROJECT_DIR" && yarn build:client)

echo "==> Syncing ${PROJECT_DIR}/ -> ${TARGET}:${REMOTE_DIR}/"
# `data` is excluded rather than merged: the layouts document is written on
# the device by the editor, so letting --delete near it would wipe real edits
# on every deploy.
rsync -avz --delete \
  --exclude '.git' \
  --exclude '.idea' \
  --exclude '.DS_Store' \
  --exclude 'node_modules' \
  --exclude 'epd_util/build' \
  --exclude 'epd_update_util' \
  --exclude '*.png' \
  --exclude 'data' \
  --exclude 'client' \
  "$PROJECT_DIR"/ "${TARGET}:${REMOTE_DIR}/"

echo "==> Installing dependencies, rebuilding epd_util, restarting service on device"
ssh "$TARGET" "cd '${REMOTE_DIR}' && yarn install --production && bash post-deployment-script.sh"

echo "==> Deploy complete"
