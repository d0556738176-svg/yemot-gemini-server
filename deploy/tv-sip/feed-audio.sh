#!/usr/bin/env bash
set -euo pipefail
# EXTERNAL SIP SERVER ONLY. Environment keys are server-controlled allowlist.
case "${1:-}" in
  TV_KAN11_URL|TV_12_URL|TV_13_URL|TV_14_URL|TV_I24_URL|TV_KNESSET_URL) var="$1" ;;
  *) exit 64 ;;
esac
url="${!var:-}"
case "$url" in https://*|http://*) ;; *) exit 65 ;; esac
# Require source licensing/approval before populating the six environment keys.
# No shell interpolation of feed URLs. FFmpeg arguments are explicitly separated.
while :; do
  ffmpeg -nostdin -hide_banner -loglevel error \
    -reconnect 1 -reconnect_streamed 1 -reconnect_delay_max 6 \
    -i "$url" -vn -map 0:a:0 -ac 1 -ar 8000 -acodec pcm_s16le -f s16le - || true
  sleep 2
done
