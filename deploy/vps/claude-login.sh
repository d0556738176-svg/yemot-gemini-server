#!/usr/bin/env bash
# Extension 12 (owner, 28.11): sign the system in to the owner's Claude
# account, typed in the Empire console with unshifted characters only:
#   bash /opt/yemot/main/deploy/vps/claude-login.sh
# It runs Claude Code's own "setup-token". The sign-in link is also shown at
#   https://main.<ip>.sslip.io/owner12/login
# (the link alone is useless to anyone else: the secret half of the sign-in
# stays here). The owner opens it, approves, copies the code the site shows
# and PASTES it here (pasting works in the console). The long-lived token is
# saved in /opt/yemot/owner12-claude.token (root only) and NEVER shown.
# The GitHub run owner12.yml then gets it from the server, only after
# GitHub's own signed proof that it is that workflow of this repository.
set -uo pipefail
ROOT=/opt/yemot
TOK=$ROOT/owner12-claude.token
LINK=/var/lib/yemot-data/owner12-login.json
mkdir -p /var/lib/yemot-data
raw=$(mktemp); chmod 600 "$raw"
cleanup(){ [ -n "${watch:-}" ] && kill "$watch" 2>/dev/null; shred -u "$raw" 2>/dev/null || rm -f "$raw"; stty cols "$oldcols" 2>/dev/null; }
oldcols=$(stty size 2>/dev/null | cut -d' ' -f2); oldcols=${oldcols:-80}
trap cleanup EXIT
# A very wide terminal keeps the long link on one line in the output.
stty cols 1000 2>/dev/null || true
# Publish the sign-in link for the owner's browser as soon as it appears.
( for i in $(seq 1 600); do
    u=$(sed -E 's/\x1b\[[0-9;?]*[A-Za-z]//g' "$raw" 2>/dev/null | tr -d '\r' | grep -aoE 'https://[a-z.]+/oauth/authorize\?[^[:space:]]+' | tail -1)
    if [ -n "$u" ]; then printf '{"url":"%s","at":%s}\n' "$u" "$(date +%s)" > "$LINK"; break; fi
    sleep 1
  done ) & watch=$!
echo
echo "== open in your browser: /owner12/login on the main site, sign in, copy the code, paste it here, press Enter =="
echo
script -qfec "npx -y @anthropic-ai/claude-code@latest setup-token" "$raw" | sed -u -E 's/sk-ant-[A-Za-z0-9_-]+/[saved, not shown]/g'
rm -f "$LINK"
t=$(sed -E 's/\x1b\[[0-9;?]*[A-Za-z]//g' "$raw" | tr -d '\r' | grep -aoE 'sk-ant-oat[A-Za-z0-9_-]{20,}' | tail -1)
if [ -z "$t" ]; then echo; echo "!! no token came out - nothing changed. run the same command again."; exit 1; fi
umask 077; printf '%s\n' "$t" > "$TOK.new"; chmod 600 "$TOK.new"; mv "$TOK.new" "$TOK"; unset t
echo; echo "OK: claude sign-in saved for extension 12 (value not shown). nothing was restarted."
