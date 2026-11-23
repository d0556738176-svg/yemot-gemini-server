#!/usr/bin/env bash
# Owner, 23.11 (42 GB disk): temporary download/recording files must never
# fill the disk. Every 10 minutes: above 70% used, temporary files older than
# 2 hours go; above 85%, older than 30 minutes. A file some program still has
# open (a recording or download in progress) is never deleted.
set -u
pct=$(df --output=pcent / | tail -1 | tr -dc 0-9)
[ "${pct:-0}" -lt 70 ] && exit 0
age=120; [ "$pct" -ge 85 ] && age=30
open=$(mktemp); find /proc/[0-9]*/fd -lname '/tmp/*' -printf '%l\n' 2>/dev/null | sort -u > "$open"
n=0
while IFS= read -r -d '' f; do
  grep -qxF "$f" "$open" && continue
  rm -f -- "$f" && n=$((n+1))
done < <(find /tmp /var/tmp -xdev -type f -mmin +$age -print0 2>/dev/null)
find /tmp -xdev -mindepth 1 -type d -empty -mmin +$age -delete 2>/dev/null
rm -f "$open"
logger -t yemot-disk "disk ${pct}%: removed $n temporary files older than ${age} min"
