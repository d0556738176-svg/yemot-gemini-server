#!/usr/bin/env bash
set -euo pipefail

export DISPLAY="${DISPLAY:-:0}"
mkdir -p "$HOME/.vnc"
chmod 700 "$HOME/.vnc"

if ! pgrep -x Xvfb >/dev/null 2>&1; then
  Xvfb "$DISPLAY" -screen 0 1440x900x24 -nolisten tcp -ac &
fi

for _ in $(seq 1 40); do
  if xdpyinfo -display "$DISPLAY" >/dev/null 2>&1; then break; fi
  sleep 0.25
done
xdpyinfo -display "$DISPLAY" >/dev/null 2>&1 || { echo "X display failed to start" >&2; exit 1; }

if ! pgrep -x xfce4-session >/dev/null 2>&1; then
  dbus-launch --exit-with-session startxfce4 >/tmp/branch5-xfce.log 2>&1 &
fi

if ! pgrep -x x11vnc >/dev/null 2>&1; then
  # noVNC is exposed only through the Codespaces PRIVATE forwarded port.
  # Do not change port visibility to public or add credentials to repository files.
  x11vnc -display "$DISPLAY" -localhost -nopw -forever -shared -rfbport 5900 >/tmp/branch5-x11vnc.log 2>&1 &
fi

exec websockify --web=/usr/share/novnc/ 0.0.0.0:6080 localhost:5900
