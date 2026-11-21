#!/usr/bin/env bash
# Provision the NEW Empire IL Ubuntu 24.04 VPS with an isolated SIP/media service.
# DOES NOT overwrite /opt/yemot/main, /opt/yemot/ext2 or their systemd units.
# DRY RUN by default. Use --apply only after authorised channel feed URLs and
# firewall/SIP peer configuration are ready; a real phone test is still required.
set -euo pipefail
ROOT=/opt/yemot
PREREQ=/opt/yemot/tv-sip
MODE="${1:---check}"
case "$MODE" in --check|--apply) ;; *) echo 'Usage: install-empire.sh [--check|--apply]' >&2; exit 64;; esac
echo 'Checking Empire IL TV SIP prerequisites'
for cmd in git ffmpeg node systemctl; do command -v "$cmd" >/dev/null || { echo "MISSING $cmd"; exit 1; }; done
test -d "$ROOT/main" || { echo "Missing $ROOT/main"; exit 1; }
test -d "$ROOT/ext2" || { echo "Missing $ROOT/ext2"; exit 1; }
test -f "$ROOT/ext2.env" || { echo 'Missing ext2.env'; exit 1; }
if ! command -v asterisk >/dev/null; then
  echo 'Asterisk is not installed on Empire VPS'
  if [ "$MODE" = '--apply' ]; then
    apt-get update && apt-get install -y asterisk
  fi
fi
# Never enable a media route unless real server-side media feeds have been supplied.
FEEDS=(TV_KAN11_URL TV_12_URL TV_13_URL TV_14_URL TV_I24_URL TV_KNESSET_URL)
missing=0
for key in "${FEEDS[@]}"; do
  if [ -z "${!key:-}" ]; then echo "MISSING $key (authorised streaming source)"; missing=$((missing+1)); fi
done
if [ "$MODE" = '--check' ]; then
  echo "Read-only diagnostics completed; missing source definitions: $missing"
  echo 'No changes were made.'
  exit 0
fi
if [ "$missing" -gt 0 ]; then echo 'Refusing installation without authorised live media sources'; exit 2; fi
mkdir -p "$PREREQ"
# Configuration is deliberately not installed over existing Asterisk files.
# Operator must inspect and integrate the example dialplan & MOH definitions
# with trusted SIP endpoint ACLs, RTP firewall, licensing and monitoring.
echo 'Media configuration templates are in deploy/tv-sip; review and install them securely.'
echo 'Do NOT activate branch 2/8 until all six dialplan routes pass live phone tests.'
