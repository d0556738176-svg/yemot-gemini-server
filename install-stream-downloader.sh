#!/usr/bin/env bash
set -euo pipefail
# Installs only the verified free stream binary; does not restart services.
[[ "$(uname -s)" == Linux && "$(uname -m)" == x86_64 ]] || { echo 'Linux x86_64 required' >&2; exit 1; }
task_dir=$(mktemp -d)
trap 'rm -rf "$task_dir"' EXIT
curl --fail --location --proto '=https' --tlsv1.2 --max-time 120 \
  'https://github.com/nilaoda/N_m3u8DL-RE/releases/download/v0.6.0-beta/N_m3u8DL-RE_v0.6.0-beta_linux-x64_20260629.tar.gz' \
  --output "$task_dir/tool.tar.gz"
echo "2ebcd450594a08c0de0bcd502a80c5d3f89a702a0fa6604199527bb8d6eee4db  $task_dir/tool.tar.gz" | sha256sum --check --status
tar -xzf "$task_dir/tool.tar.gz" -C "$task_dir" --no-same-owner
task_binary=$(find "$task_dir" -type f -name N_m3u8DL-RE -print -quit)
[[ -n "$task_binary" ]] || { echo 'Binary missing from release' >&2; exit 1; }
chmod 755 "$task_binary"
"$task_binary" --version
install -m 755 "$task_binary" /usr/local/bin/N_m3u8DL-RE.new
mv /usr/local/bin/N_m3u8DL-RE.new /usr/local/bin/N_m3u8DL-RE
echo 'Streaming binary installed. Existing services were not restarted.'
