#!/usr/bin/env bash
# READ-ONLY diagnostics for Empire IL /2/8. Does NOT display credentials.
set -u
echo '=== Empire IL /2/8 read-only diagnostics ==='
date -Is
echo 'Network:'
ip -4 -o addr show scope global 2>/dev/null | awk '{print $2,$4}' || true
echo 'Services:'
for unit in yemot-main yemot-ext2 caddy ssh asterisk; do
  printf '%s: ' "$unit"
  systemctl is-active "$unit" 2>/dev/null || true
done
echo 'Listening sockets:'
ss -tuln 2>/dev/null | awk 'NR==1 || /:(22|80|443|5060|3000|3001)[[:space:]]/' | head -30 || true
echo 'Firewall status:'
if command -v ufw >/dev/null; then ufw status 2>/dev/null | head -20; fi
echo 'Required executables:'
for cmd in node ffmpeg asterisk; do
  if command -v "$cmd" >/dev/null 2>&1; then echo "$cmd: installed"; else echo "$cmd: MISSING"; fi
done
echo 'Local health:'
for port in 3000 3001; do
  status=$(curl --noproxy '*' -sS --connect-timeout 2 --max-time 5 -o /dev/null -w '%{http_code}' "http://127.0.0.1:${port}/health" 2>/dev/null || true)
  echo "port $port health HTTP ${status:-no-connection}"
done
echo 'VPS code check:'
for dir in /opt/yemot/main /opt/yemot/ext2; do
 if test -d "$dir/.git"; then
   echo "$dir branch=$(git -C "$dir" branch --show-current 2>/dev/null) commit=$(git -C "$dir" rev-parse --short HEAD 2>/dev/null)"
 else echo "$dir: missing git checkout"; fi
done
echo 'SIP configuration existence (not contents):'
for file in /etc/asterisk/pjsip.conf /etc/asterisk/extensions.conf /etc/asterisk/musiconhold.conf; do
  test -e "$file" && echo "$file: present" || echo "$file: absent"
done
echo '=== END read-only diagnostics ==='
