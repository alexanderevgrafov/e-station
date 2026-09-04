#!/bin/bash
# Runs on the device, over SSH, at the end of scripts/deploy.sh.
set -euo pipefail

APP_DIR=/home/dietpi/e-station
UNIT=e-station-server.service
UNIT_SRC="$APP_DIR/deploy/$UNIT"
UNIT_DST="/etc/systemd/system/$UNIT"
BASE_URL=http://localhost:3333

cd "$APP_DIR"

# The unit file is versioned in the repo and installed from it, so ExecStart
# can never drift from what the code actually is. It drifted once already:
# server.js was renamed to server.ts and the unit kept pointing at the old
# name, leaving the service in a crash loop that the deploy reported as a
# success.
echo "**** Service unit ****"
if ! cmp -s "$UNIT_SRC" "$UNIT_DST"; then
  echo "unit changed - installing $UNIT_DST"
  cp "$UNIT_SRC" "$UNIT_DST"
  systemctl daemon-reload
  systemctl enable "$UNIT"
else
  echo "unit unchanged"
fi

# Before the restart, not after: the service should come up against a freshly
# built binary rather than briefly running with a stale or half-written one.
echo "**** Make ****"
make -C ./epd_util

echo "**** Restart ****"
systemctl restart "$UNIT"

echo "**** Waiting for server ****"
ready=""
for _ in $(seq 1 20); do
  if curl -fs -o /dev/null "$BASE_URL/api/status"; then
    ready=1
    break
  fi
  sleep 1
done

# The old version of this loop just fell through when every attempt failed,
# then ran the remaining curls with -s and exited 0 - so a totally dead server
# still looked like a clean deploy. Fail loudly instead, with the reason.
if [ -z "$ready" ]; then
  echo "!!!! Server did not come up on $BASE_URL - last log lines:" >&2
  systemctl status "$UNIT" --no-pager --lines=0 >&2 || true
  journalctl -u "$UNIT" -n 30 --no-pager >&2 || true
  exit 1
fi

# No "start the clock" step any more: nothing inside the server drives content
# now. Whatever wants the time on screen calls /intake/<area>?text=... The
# server paints the current layout once at startup on its own, so this is just
# a clean baseline.
echo "**** Full refresh ****"
curl -fs "$BASE_URL/api/clear-full"
echo

echo "**** Status ****"
curl -fs "$BASE_URL/api/status"
echo

echo "**** Deploy OK ****"
