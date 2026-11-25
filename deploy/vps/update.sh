#!/usr/bin/env bash
# Runs every minute (yemot-update.timer).
# If an app's branch moved on GitHub: pull, install, and restart it - but only
# when the app has been quiet (no log lines) for 90 seconds, so a restart never
# cuts a live call. After 30 minutes of waiting it restarts anyway.
set -u
ROOT=/opt/yemot
for n in main ext2; do
  d=$ROOT/$n; b=$(git -C $d rev-parse --abbrev-ref HEAD)
  git -C $d fetch -q origin "$b" || continue
  # 15.11: compared with the version that is really RUNNING (written after each
  # restart), not the folder: a manual "git pull" must never skip a restart.
  want=$(git -C $d rev-parse origin/$b)
  [ "$(cat $ROOT/.running-$n 2>/dev/null)" = "$want" ] && { rm -f /run/yemot-wait-$n; continue; }
  busy=$(journalctl -u yemot-$n --since -90s -q -o cat 2>/dev/null | grep -c . || true)
  [ -f /run/yemot-wait-$n ] || date +%s > /run/yemot-wait-$n
  waited=$(( $(date +%s) - $(cat /run/yemot-wait-$n) ))
  if [ "${busy:-0}" -gt 0 ] && [ $waited -lt 1800 ]; then continue; fi
  git -C $d reset -q --hard "origin/$b"
  (cd $d && npm install --omit=dev --no-audit --no-fund >/dev/null 2>&1)
  systemctl restart yemot-$n
  echo "$want" > $ROOT/.running-$n
  rm -f /run/yemot-wait-$n
  logger -t yemot-update "$n updated to $(git -C $d rev-parse --short HEAD) (waited ${waited}s)"
  [ $n = main ] && bash $ROOT/main/deploy/vps/maintain.sh >/dev/null 2>&1
done
# Live conversation checks of extensions 1 and 3 (owner, 24.11): a question
# list on the side branch verify/ask becomes an owner-check (the same as the
# owner running ask.mjs by hand). It changes nothing in the system: no code,
# no restart; the check runs as one simulated call, phone 0000000009.
ask_sha=$(git -C $ROOT/main ls-remote -q origin refs/heads/verify/ask 2>/dev/null | cut -f1)
if [ -n "$ask_sha" ] && [ "$ask_sha" != "$(cat $ROOT/.ask-seen 2>/dev/null)" ]; then
  echo "$ask_sha" > $ROOT/.ask-seen
  if git -C $ROOT/main fetch -q origin verify/ask 2>/dev/null; then
    git -C $ROOT/main show FETCH_HEAD:ask/request.json 2>/dev/null | node -e '
      let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{
        const j=JSON.parse(s), fs=require("fs");
        if(!/^[a-f0-9]{24}$/.test(j.name||"")) return;
        const q=(j.questions||[]).map(String).map(x=>x.slice(0,400)).filter(Boolean).slice(0,20);
        if(!q.length) return;
        fs.mkdirSync("/var/lib/yemot-report",{recursive:true,mode:0o700});
        fs.writeFileSync("/var/lib/yemot-report/"+j.name+".ask",JSON.stringify({branch:j.branch==="1"?"1":j.branch==="4"?"4":"3",questions:q}),{mode:0o600});
      }catch{}});' && logger -t yemot-update "conversation check queued"
  fi
fi
# Owner's log extract (25.11): a request on the side branch verify/logs
# becomes a read-only extract of the server log (deploy/vps/log-extract.mjs),
# served for 2 hours at /owner-report/<name>. Changes nothing, restarts nothing.
logs_sha=$(git -C $ROOT/main ls-remote -q origin refs/heads/verify/logs 2>/dev/null | cut -f1)
if [ -n "$logs_sha" ] && [ "$logs_sha" != "$(cat $ROOT/.logs-seen 2>/dev/null)" ]; then
  echo "$logs_sha" > $ROOT/.logs-seen
  if git -C $ROOT/main fetch -q origin verify/logs 2>/dev/null; then
    req=$(git -C $ROOT/main show FETCH_HEAD:logs/request.json 2>/dev/null | head -c 2000)
    [ -n "$req" ] && timeout 120 node $ROOT/main/deploy/vps/log-extract.mjs "$req" >/dev/null 2>&1 && logger -t yemot-update "log extract written"
  fi
fi
# keep this script itself current
cmp -s $ROOT/main/deploy/vps/update.sh /usr/local/bin/yemot-update || install -m 755 $ROOT/main/deploy/vps/update.sh /usr/local/bin/yemot-update
