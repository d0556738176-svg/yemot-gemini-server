#!/usr/bin/env bash
# Put one key into a setting of an app, typed or pasted in the Empire
# console WITHOUT showing it and without it entering the command history.
# Only unshifted characters are needed to run it:
#   bash /opt/yemot/main/deploy/vps/set-key.sh main serper-api-key
# then paste the key (nothing is shown) and press Enter.
# The console turns _ into -, so dashes in the name become underscores.
set -euo pipefail
app=${1:-}; name=$(echo "${2:-}" | tr a-z- A-Z_)
case "$app" in main|ext2) ;; *) echo "usage: bash set-key.sh <main|ext2> <setting-name>"; exit 1;; esac
[[ "$name" =~ ^[A-Z][A-Z0-9_]{2,60}$ ]] || { echo "bad setting name"; exit 1; }
printf 'paste the key for %s and press Enter (it is not shown): ' "$name"
IFS= read -rs val; echo
val=$(printf '%s' "$val" | tr -d '\r\n\t ')
[[ "$val" =~ ^[A-Za-z0-9._:-]{16,200}$ ]] || { echo "this does not look like a key; nothing changed"; exit 1; }
f=/opt/yemot/$app.env
grep -v "^$name=" "$f" > "$f.new" || true
printf '%s="%s"\n' "$name" "$val" >> "$f.new"
chmod 600 "$f.new"; mv "$f.new" "$f"; unset val
systemctl restart yemot-$app
sleep 3
systemctl is-active --quiet yemot-$app && echo "OK: $name set for $app (${#name} letters name; value not shown), $app restarted and running" || echo "!! $app did not start; run: journalctl -u yemot-$app -n 30"
