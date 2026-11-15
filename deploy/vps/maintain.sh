#!/usr/bin/env bash
# Idempotent upkeep so the server never fills up. Run after every main update.
# Logs: keep at most 500 MB of system logs.
mkdir -p /etc/systemd/journald.conf.d
printf '[Journal]\nSystemMaxUse=500M\n' > /etc/systemd/journald.conf.d/yemot.conf
systemctl restart systemd-journald
# Temporary media files: delete anything in /tmp older than 12 hours, every hour.
cat > /etc/systemd/system/yemot-clean.service <<'UNIT'
[Unit]
Description=Delete old temporary media files
[Service]
Type=oneshot
ExecStart=/usr/bin/find /tmp /var/tmp -xdev -type f -mmin +720 -delete
UNIT
cat > /etc/systemd/system/yemot-clean.timer <<'UNIT'
[Unit]
Description=Hourly cleanup of temporary media files
[Timer]
OnBootSec=10min
OnUnitActiveSec=1h
[Install]
WantedBy=timers.target
UNIT
systemctl daemon-reload
systemctl enable --now yemot-clean.timer
# Security updates install automatically (Ubuntu default); make sure it is on.
systemctl enable --now unattended-upgrades >/dev/null 2>&1 || true
# Setting names typed through the console may have - instead of _ (no Shift).
for app in main ext2; do
  f=/opt/yemot/$app.env
  if grep -q '^[A-Z0-9]*-[A-Z0-9-]*=' "$f" 2>/dev/null; then
    sed -i -E ':a; s/^([A-Z0-9_]*)-([A-Z0-9_-]*=)/\1_\2/; ta' "$f"
    systemctl restart yemot-$app
  fi
done

# ---- Addresses: nothing may still point at the old Render services ----
IP=$(curl -fsS -m 10 https://api.ipify.org || hostname -I | awk '{print $1}')
MAIN=https://main.${IP//./-}.sslip.io; EXT2=https://ext2.${IP//./-}.sslip.io
fixenv() { # file  -> rewrites onrender addresses, returns 0 if changed
  local f=$1 before; before=$(md5sum < "$f")
  sed -i -E \
    -e '/^[A-Z0-9_]+="?https:\/\/[a-z0-9-]*audio-worker[a-z0-9-]*\.onrender\.com/d' \
    -e "s#https://[a-z0-9-]*branch2[a-z0-9-]*\.onrender\.com#$EXT2#g" \
    -e "s#https://yemot-course-builder\.onrender\.com#http://127.0.0.1:3002#g" \
    -e "s#https://[a-z0-9-]+\.onrender\.com#$MAIN#g" "$f"
  setkv "$f" "${@:2}"
  [ "$before" != "$(md5sum < "$f")" ]
}
setkv() { local f=$1; shift; for kv in "$@"; do k=${kv%%=*}; grep -v "^$k=" "$f" > "$f.n"; echo "$k=\"${kv#*=}\"" >> "$f.n"; mv "$f.n" "$f"; done; chmod 600 "$f"; }
changed_main=0; changed_ext2=0
fixenv /opt/yemot/main.env EXT2_MEDIA_URL=$EXT2 COURSE_BUILDER_URL=http://127.0.0.1:3002 YEMOT_EXT2_BASE_URL=$EXT2 && changed_main=1
fixenv /opt/yemot/ext2.env WEB_HINTS_URL=$MAIN && changed_ext2=1
# Course builder (lessons for extension 6) runs here too, on port 3002.
cat > /etc/systemd/system/yemot-builder.service <<UNIT
[Unit]
Description=Yemot course builder
After=network-online.target
[Service]
WorkingDirectory=/opt/yemot/main
EnvironmentFile=/opt/yemot/main.env
ExecStart=/usr/bin/env PORT=3002 /usr/bin/node course-builder.js
Restart=always
RestartSec=3
[Install]
WantedBy=multi-user.target
UNIT
systemctl daemon-reload
systemctl enable --now yemot-builder >/dev/null 2>&1
[ $changed_main = 1 ] && systemctl restart yemot-main yemot-builder
[ $changed_ext2 = 1 ] && systemctl restart yemot-ext2
echo "addresses: main_changed=$changed_main ext2_changed=$changed_ext2"
echo MAINTAIN-OK
