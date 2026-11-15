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
echo MAINTAIN-OK
