#!/usr/bin/env bash
# One-time setup of the Empire IL VPS (Ubuntu 24.04) that replaces Render.
# Runs two Node apps behind Caddy (free automatic HTTPS):
#   main  (branch main)                          -> https://main.<ip-dashed>.sslip.io  (port 3000)
#   ext2  (branch work/branch-2-confirm-yes-...) -> https://ext2.<ip-dashed>.sslip.io  (port 3001)
# Settings and keys are copied straight from Render's API (key in /root/.render-key),
# so no secret passes through chat. Re-runnable.
set -euo pipefail
export DEBIAN_FRONTEND=noninteractive
IP=$(curl -fsS https://api.ipify.org || hostname -I | awk '{print $1}')
DASH=${IP//./-}
MAIN_HOST="main.$DASH.sslip.io"; EXT2_HOST="ext2.$DASH.sslip.io"
EXT2_BRANCH=${EXT2_BRANCH:-work/branch-2-confirm-yes-20261025}
ROOT=/opt/yemot; mkdir -p $ROOT

echo "== console autologin (the browser console is reachable only from the owner's Empire account)"
mkdir -p /etc/systemd/system/getty@tty1.service.d
printf '[Service]\nExecStart=\nExecStart=-/sbin/agetty --autologin root --noclear %%I $TERM\n' > /etc/systemd/system/getty@tty1.service.d/autologin.conf
passwd -l root >/dev/null 2>&1 || true   # no password logins for root at all

echo "== packages"
cloud-init status --wait >/dev/null 2>&1 || true
apt-get update -y
apt-get install -y git curl ffmpeg python3 python3-pip ca-certificates gnupg debian-keyring debian-archive-keyring apt-transport-https unzip
if ! command -v node >/dev/null || ! node -v | grep -q '^v22'; then
  curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
  apt-get install -y nodejs
fi
if ! command -v caddy >/dev/null; then
  curl -1sLf https://dl.cloudsmith.io/public/caddy/stable/gpg.key | gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
  curl -1sLf https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt > /etc/apt/sources.list.d/caddy-stable.list
  apt-get update -y && apt-get install -y caddy
fi
if ! command -v deno >/dev/null; then  # yt-dlp needs a JS runtime for YouTube
  curl -fsSL https://github.com/denoland/deno/releases/latest/download/deno-x86_64-unknown-linux-gnu.zip -o /tmp/deno.zip
  unzip -o /tmp/deno.zip -d /usr/local/bin && rm /tmp/deno.zip
fi
# swap, so a heavy ffmpeg job can never kill the server
if ! swapon --show | grep -q swapfile; then
  fallocate -l 2G /swapfile && chmod 600 /swapfile && mkswap /swapfile && swapon /swapfile
  grep -q swapfile /etc/fstab || echo '/swapfile none swap sw 0 0' >> /etc/fstab
fi

echo "== code"
REPO_URL=$(head -n1 /root/u)   # https URL with a read-only token (typed in once through the console)
clone() { # dir branch
  if [ ! -d "$1/.git" ]; then git clone -b "$2" "$REPO_URL" "$1"
  else git -C "$1" fetch origin "$2" && git -C "$1" checkout -B "$2" "origin/$2"; fi
  (cd "$1" && npm install --omit=dev --no-audit --no-fund)
}
clone $ROOT/main main
clone $ROOT/ext2 "$EXT2_BRANCH"

echo "== settings from Render"
if [ -s /root/.render-key ]; then
node $ROOT/main/deploy/vps/render-env.mjs srv-das184ojo6nc739qecr0 $ROOT/main.env \
  PORT=3000 PUBLIC_BASE_URL=https://$MAIN_HOST RENDER_EXTERNAL_URL=https://$MAIN_HOST
node $ROOT/main/deploy/vps/render-env.mjs srv-dbf3voivcj2c73eohsi0 $ROOT/ext2.env \
  PORT=3001 PUBLIC_BASE_URL=https://$EXT2_HOST RENDER_EXTERNAL_URL=https://$EXT2_HOST
chmod 600 $ROOT/*.env
else
  echo "!! /root/.render-key missing: settings not copied yet"; touch $ROOT/main.env $ROOT/ext2.env
fi
chmod 600 /root/u

echo "== services"
for n in main ext2; do
cat > /etc/systemd/system/yemot-$n.service <<UNIT
[Unit]
Description=Yemot $n
After=network-online.target
[Service]
WorkingDirectory=$ROOT/$n
EnvironmentFile=$ROOT/$n.env
ExecStart=/usr/bin/node server.js
Restart=always
RestartSec=2
[Install]
WantedBy=multi-user.target
UNIT
done
cat > /etc/caddy/Caddyfile <<CADDY
$MAIN_HOST {
  reverse_proxy 127.0.0.1:3000
}
$EXT2_HOST {
  reverse_proxy 127.0.0.1:3001
}
CADDY
install -m 755 $ROOT/main/deploy/vps/update.sh /usr/local/bin/yemot-update
cat > /etc/systemd/system/yemot-update.service <<'UNIT'
[Unit]
Description=Pull new code for Yemot apps
[Service]
Type=oneshot
ExecStart=/usr/local/bin/yemot-update
UNIT
cat > /etc/systemd/system/yemot-update.timer <<'UNIT'
[Unit]
Description=Check GitHub for Yemot updates every minute
[Timer]
OnBootSec=1min
OnUnitActiveSec=1min
[Install]
WantedBy=timers.target
UNIT
systemctl daemon-reload
systemctl enable --now yemot-main yemot-ext2 yemot-update.timer
systemctl restart yemot-main yemot-ext2 caddy
ufw allow 22/tcp >/dev/null 2>&1 || true; ufw allow 80/tcp >/dev/null 2>&1 || true; ufw allow 443/tcp >/dev/null 2>&1 || true
sleep 8
echo "== check"
for h in $MAIN_HOST $EXT2_HOST; do echo -n "$h -> "; curl -s -o /dev/null -w "%{http_code}\n" https://$h/health || true; done
echo "DONE main=https://$MAIN_HOST ext2=https://$EXT2_HOST"
