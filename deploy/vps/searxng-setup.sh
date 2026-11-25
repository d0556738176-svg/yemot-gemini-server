#!/usr/bin/env bash
# Owner, 25.11 (approved): our own search engine on this server, a backup for
# when the search services' quotas run out. SearXNG, only on 127.0.0.1:8888
# (never open outside), with the engines that answer a server's address:
# Bing, DuckDuckGo and Wikipedia (Google, Brave, Startpage, Qwant and Mojeek
# block servers or need heavy CPU, so they are off). Low priority and capped
# (CPU 40%, memory 450 MB) so downloads and calls always come first.
# Idempotent; maintain.sh runs it in the background; a failure changes nothing.
set -u
LOG=/var/log/yemot-searxng-setup.log
exec >>"$LOG" 2>&1
echo "== $(date -Is) setup"
exec 9>/run/yemot-searxng-setup.lock
flock -n 9 || { echo "another setup is running"; exit 0; }
export DEBIAN_FRONTEND=noninteractive
if [ ! -x /opt/searxng/venv/bin/python ] || [ ! -d /opt/searxng/src/.git ]; then
  echo "installing system packages"
  apt-get install -y -q python3-venv python3-dev build-essential libxslt1-dev zlib1g-dev libffi-dev libssl-dev git >/dev/null || true
fi
id searxng >/dev/null 2>&1 || useradd --system --home-dir /opt/searxng --shell /usr/sbin/nologin searxng
mkdir -p /opt/searxng /etc/searxng
if [ ! -d /opt/searxng/src/.git ]; then
  echo "downloading SearXNG"
  git clone -q --depth 1 https://github.com/searxng/searxng /opt/searxng/src || { echo "clone failed"; exit 1; }
  rm -f /opt/searxng/.installed
fi
[ -x /opt/searxng/venv/bin/python ] || python3 -m venv /opt/searxng/venv || exit 1
if [ ! -f /opt/searxng/.installed ]; then
  echo "installing SearXNG (a few minutes)"
  nice -n 15 /opt/searxng/venv/bin/pip install -q -U pip setuptools wheel pyyaml msgspec typing_extensions || exit 1
  nice -n 15 /opt/searxng/venv/bin/pip install -q --use-pep517 --no-build-isolation -e /opt/searxng/src || exit 1
  touch /opt/searxng/.installed
  echo "installed"
fi
key=$(sed -n 's/^  secret_key: "\(.*\)"$/\1/p' /etc/searxng/settings.yml 2>/dev/null | head -1)
[ -n "$key" ] || key=$(head -c 32 /dev/urandom | od -An -tx1 | tr -d ' \n')
cat > /etc/searxng/settings.yml.new <<YML
use_default_settings:
  engines:
    keep_only:
      - bing
      - bing news
      - duckduckgo
      - wikipedia
general:
  instance_name: "yemot"
search:
  safe_search: 2
  default_lang: "he"
  formats: [html, json]
  suspended_times:
    SearxEngineAccessDenied: 3600
    SearxEngineCaptcha: 3600
    SearxEngineTooManyRequests: 600
server:
  secret_key: "$key"
  bind_address: "127.0.0.1"
  port: 8888
  limiter: false
  image_proxy: false
  public_instance: false
outgoing:
  request_timeout: 3.0
  max_request_timeout: 6.0
  pool_connections: 20
  pool_maxsize: 5
engines:
  - name: bing
    disabled: false
  - name: bing news
    disabled: false
  - name: duckduckgo
    disabled: false
    timeout: 4.0
  - name: wikipedia
    disabled: false
YML
changed=0
cmp -s /etc/searxng/settings.yml.new /etc/searxng/settings.yml || { mv /etc/searxng/settings.yml.new /etc/searxng/settings.yml; changed=1; }
rm -f /etc/searxng/settings.yml.new
chmod 640 /etc/searxng/settings.yml
chown -R searxng:searxng /opt/searxng /etc/searxng
cat > /etc/systemd/system/yemot-searxng.service.new <<'UNIT'
[Unit]
Description=Our own search engine (SearXNG, local only, low priority)
After=network-online.target
[Service]
User=searxng
Group=searxng
Environment=SEARXNG_SETTINGS_PATH=/etc/searxng/settings.yml
WorkingDirectory=/opt/searxng/src
ExecStart=/opt/searxng/venv/bin/python -m searx.webapp
Restart=always
RestartSec=10
Nice=10
CPUQuota=40%
IOSchedulingClass=idle
MemoryMax=450M
[Install]
WantedBy=multi-user.target
UNIT
cmp -s /etc/systemd/system/yemot-searxng.service.new /etc/systemd/system/yemot-searxng.service || { mv /etc/systemd/system/yemot-searxng.service.new /etc/systemd/system/yemot-searxng.service; changed=1; }
rm -f /etc/systemd/system/yemot-searxng.service.new
systemctl daemon-reload
systemctl enable -q yemot-searxng
if [ "$changed" = 1 ] || ! systemctl is-active -q yemot-searxng; then systemctl restart yemot-searxng; fi
for i in $(seq 1 30); do curl -fsS -m 10 'http://127.0.0.1:8888/search?q=%D7%99%D7%A8%D7%95%D7%A9%D7%9C%D7%99%D7%9D&format=json' >/dev/null 2>&1 && { echo "up"; exit 0; }; sleep 4; done
echo "not answering yet"
