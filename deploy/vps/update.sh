#!/usr/bin/env bash
# Every minute: if the app's branch moved on GitHub, pull, install and restart it.
set -u
for n in main ext2; do
  d=/opt/yemot/$n; b=$(git -C $d rev-parse --abbrev-ref HEAD)
  git -C $d fetch -q origin "$b" || continue
  [ "$(git -C $d rev-parse HEAD)" = "$(git -C $d rev-parse origin/$b)" ] && continue
  git -C $d reset -q --hard "origin/$b"
  (cd $d && npm install --omit=dev --no-audit --no-fund >/dev/null 2>&1)
  systemctl restart yemot-$n
  logger -t yemot-update "$n updated to $(git -C $d rev-parse --short HEAD)"
done
