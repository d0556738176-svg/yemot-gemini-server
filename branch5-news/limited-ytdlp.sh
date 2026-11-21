#!/usr/bin/env bash
# Only wraps the same free executable used by extension 2. No other engine.
set -euo pipefail
args=()
while [ "$#" -gt 0 ]; do
  if [ "$1" = '--concurrent-fragments' ]; then shift 2; else args+=("$1"); shift; fi
done
exec /usr/local/bin/yt-dlp --limit-rate 512K --concurrent-fragments 1 --max-filesize 512M "${args[@]}"
