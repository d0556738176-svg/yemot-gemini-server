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
# Disk guard (23.11): every 10 minutes, old temporary files go when the disk
# is getting full (files still open are kept).
install -m 755 /opt/yemot/main/deploy/vps/disk-guard.sh /usr/local/bin/yemot-disk-guard
cat > /etc/systemd/system/yemot-disk.service <<'UNIT'
[Unit]
Description=Keep the disk from filling with temporary files
[Service]
Type=oneshot
Nice=10
ExecStart=/usr/local/bin/yemot-disk-guard
UNIT
cat > /etc/systemd/system/yemot-disk.timer <<'UNIT'
[Unit]
Description=Disk guard every 10 minutes
[Timer]
OnBootSec=5min
OnUnitActiveSec=10min
[Install]
WantedBy=timers.target
UNIT
systemctl daemon-reload
systemctl enable --now yemot-disk.timer
# YouTube changes often: the downloader of extension 2 updates itself every
# night (and now), so direct downloads keep working (15.11).
cat > /etc/systemd/system/yemot-ytdlp.service <<'UNIT'
[Unit]
Description=Update yt-dlp of extension 2
[Service]
Type=oneshot
ExecStart=/bin/sh -c 'curl -fsSL --retry 3 -o /usr/local/bin/yt-dlp.new https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp_linux && chmod 755 /usr/local/bin/yt-dlp.new && /usr/local/bin/yt-dlp.new --version && mv -f /usr/local/bin/yt-dlp.new /usr/local/bin/yt-dlp'
UNIT
cat > /etc/systemd/system/yemot-ytdlp.timer <<'UNIT'
[Unit]
Description=Nightly yt-dlp update
[Timer]
OnCalendar=*-*-* 03:30
Persistent=true
[Install]
WantedBy=timers.target
UNIT
systemctl daemon-reload
systemctl enable --now yemot-ytdlp.timer
systemctl start yemot-ytdlp.service || true
# Local map of Israel for "the nearest X to Y" (19.11): built now if missing,
# refreshed every week.
cat > /etc/systemd/system/yemot-osm.service <<'UNIT'
[Unit]
Description=Build the local map of Israel (OpenStreetMap)
[Service]
Type=oneshot
Nice=10
ExecStart=/bin/bash /opt/yemot/main/deploy/vps/osm-update.sh
UNIT
cat > /etc/systemd/system/yemot-osm.timer <<'UNIT'
[Unit]
Description=Weekly local map refresh
[Timer]
OnCalendar=Sun *-*-* 02:40
Persistent=true
[Install]
WantedBy=timers.target
UNIT
systemctl daemon-reload
systemctl enable --now yemot-osm.timer
[ -f /var/lib/yemot-data/osm/built.json ] || systemctl start --no-block yemot-osm.service || true
# The browser console cannot send Ctrl+C (Ctrl and Shift are dropped), so a
# log reader left following on the console (journalctl -f) would block it for
# good: any journalctl on the console is stopped at each update (19.11).
pkill -t tty1 -x journalctl 2>/dev/null || true
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
    -e '/^BRANCH3_DEEP_TEST=/d' -e '/^SONG_MAX_PER_HOUR=/d' \
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
# 25.11 (owner approved): our own search engine (SearXNG, local only, low
# priority), set up or kept up to date in the background.
nohup setsid bash /opt/yemot/main/deploy/vps/searxng-setup.sh >/dev/null 2>&1 < /dev/null &
echo MAINTAIN-OK
