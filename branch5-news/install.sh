#!/usr/bin/env bash
# Run from an isolated checkout of feature/branch5-news-free-only.
# Does not fetch/reset/restart main or ext2, and does not configure Yemot.
set -euo pipefail
[ "$(id -u)" = 0 ] || { echo 'Run as root'; exit 1; }
[ -s /opt/yemot/ext2/youtube-direct.js ] || { echo 'Extension 2 direct downloader missing'; exit 1; }
[ -x /usr/local/bin/yt-dlp ] && [ -x /usr/bin/ffmpeg ]
node -e "require('node:sqlite')" >/dev/null
mkdir -p /var/lib/yemot-news5
chmod 700 /var/lib/yemot-news5
cd /opt/yemot/news5
# Reuse installed libraries read-only; never npm-install into existing apps.
[ -e node_modules ] || ln -s /opt/yemot/main/node_modules node_modules
chmod 755 branch5-news/limited-ytdlp.sh
if [ ! -s /opt/yemot/news5.env ]; then
  umask 077
  printf 'NEWS5_ACCESS_KEY=%s\nNEWS5_ENABLED=false\nNEWS5_PORT=3005\n' "$(openssl rand -hex 32)" > /opt/yemot/news5.env
fi
install -m 644 branch5-news/yemot-news5.service /etc/systemd/system/yemot-news5.service
systemctl daemon-reload
systemctl enable --now yemot-news5
curl --fail --max-time 10 http://127.0.0.1:3005/health
echo 'News5 installed in preview mode. No downloads and no extension changes.'
