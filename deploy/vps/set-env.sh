#!/usr/bin/env bash
# Set one setting for an app from a hex file typed through the console
# (the browser console cannot type capitals or shifted symbols).
# Usage: bash set-env.sh <main|ext2> <setting_name_lowercase> <hexfile>
set -euo pipefail
app=$1; name=$(echo "$2" | tr a-z A-Z); val=$(xxd -r -p "$3" | tr -d '\r\n')
f=/opt/yemot/$app.env
grep -v "^$name=" "$f" > "$f.new" || true
printf '%s="%s"\n' "$name" "$val" >> "$f.new"
chmod 600 "$f.new"; mv "$f.new" "$f"; rm -f "$3"
systemctl restart yemot-$app
echo "SET $name for $app (value not shown)"
