#!/usr/bin/env bash
# Runs every minute (yemot-update.timer).
# If an app's branch moved on GitHub: pull, install, and restart it - but only
# when the app has been quiet (no log lines) for 90 seconds, so a restart never
# cuts a live call. After 30 minutes of waiting it restarts anyway.
set -u
ROOT=/opt/yemot
for n in main ext2; do
  d=$ROOT/$n; b=$(git -C $d rev-parse --abbrev-ref HEAD)
  git -C $d fetch -q origin "$b" || continue
  [ "$(git -C $d rev-parse HEAD)" = "$(git -C $d rev-parse origin/$b)" ] && { rm -f /run/yemot-wait-$n; continue; }
  busy=$(journalctl -u yemot-$n --since -90s -q -o cat 2>/dev/null | grep -c . || true)
  [ -f /run/yemot-wait-$n ] || date +%s > /run/yemot-wait-$n
  waited=$(( $(date +%s) - $(cat /run/yemot-wait-$n) ))
  if [ "${busy:-0}" -gt 0 ] && [ $waited -lt 1800 ]; then continue; fi
  git -C $d reset -q --hard "origin/$b"
  (cd $d && npm install --omit=dev --no-audit --no-fund >/dev/null 2>&1)
  systemctl restart yemot-$n
  rm -f /run/yemot-wait-$n
  logger -t yemot-update "$n updated to $(git -C $d rev-parse --short HEAD) (waited ${waited}s)"
  [ $n = main ] && bash $ROOT/main/deploy/vps/maintain.sh >/dev/null 2>&1
done
# keep this script itself current
cmp -s $ROOT/main/deploy/vps/update.sh /usr/local/bin/yemot-update || install -m 755 $ROOT/main/deploy/vps/update.sh /usr/local/bin/yemot-update
