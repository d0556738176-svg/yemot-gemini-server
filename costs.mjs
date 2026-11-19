// Read-only cost/limit audit (19.11). Prints NO key values: names, statuses,
// balances and usage only. Output goes to a private 2-hour report.
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
const out = [];
const log = (...a) => out.push(a.join(' '));
const loadEnv = f => { const e = {}; try { for (const l of readFileSync(f, 'utf8').split('\n')) { const m = l.match(/^([A-Z0-9_]+)="(.*)"$/); if (m) e[m[1]] = m[2].replace(/\\"/g, '"').replace(/\\\\/g, '\\'); } } catch {} return e; };
const main = loadEnv('/opt/yemot/main.env'), ext2 = loadEnv('/opt/yemot/ext2.env');
Object.assign(process.env, ext2, main);
const j = async (url, opts = {}) => { try { const r = await fetch(url, { ...opts, signal: AbortSignal.timeout(20000) }); const t = await r.text(); let b = null; try { b = JSON.parse(t); } catch {} return { status: r.status, body: b, text: t.slice(0, 200) }; } catch (e) { return { status: 0, text: String(e?.message || e).slice(0, 120) }; } };

log('== 1. Keys of the main app (status of each key, from the same check the server runs)');
const ci = console.info; console.info = (...a) => out.push('  ' + a.join(' ').replace('[KEY_REPORT] ', ''));
try { const { keyReport } = await import('/opt/yemot/main/key-slots.js'); await keyReport(); } catch (e) { log('  key check failed: ' + e.message); }
console.info = ci;

log('\n== 2. Deepgram (speech to text) balance');
for (const n of Object.keys(process.env).filter(n => /DEEPGRAM.*KEY/.test(n))) {
  const k = process.env[n]; if (!k) continue;
  const p = await j('https://api.deepgram.com/v1/projects', { headers: { authorization: 'Token ' + k } });
  const id = p.body?.projects?.[0]?.project_id;
  if (!id) { log('  ' + n + ': projects ' + p.status + ' ' + (p.body ? '' : p.text)); continue; }
  const b = await j('https://api.deepgram.com/v1/projects/' + id + '/balances', { headers: { authorization: 'Token ' + k } });
  log('  ' + n + ': ' + JSON.stringify((b.body?.balances || []).map(x => ({ amount: x.amount, units: x.units }))) + ' (status ' + b.status + ')');
}

log('\n== 3. Apify (download backup engine) usage this month');
for (const n of Object.keys(process.env).filter(n => /APIFY/.test(n) && /TOKEN|KEY/.test(n)).sort()) {
  const k = process.env[n]; if (!k) continue;
  const l = await j('https://api.apify.com/v2/users/me/limits?token=' + encodeURIComponent(k));
  const d = l.body?.data;
  log('  ' + n + ': ' + (d ? 'used $' + Number(d.current?.monthlyUsageUsd || 0).toFixed(2) + ' of $' + Number(d.limits?.maxMonthlyUsageUsd || 0).toFixed(2) + ' (cycle ends ' + String(d.monthlyUsageCycle?.endAt || '').slice(0, 10) + ')' : 'status ' + l.status));
}

log('\n== 4. Other paid-looking settings present (names only)');
log('  ' + Object.keys(process.env).filter(n => /(OPENAI|FAL_|ELEVEN|REPLICATE|ANTHROPIC|AZURE|GOOGLE_MAPS|GOOGLE_VISION|MODAL|HF_TOKEN|GITHUB_DISPATCH)/.test(n) && process.env[n]).sort().join(', '));
if (process.env.OPENAI_API_KEY) { const o = await j('https://api.openai.com/v1/models', { headers: { authorization: 'Bearer ' + process.env.OPENAI_API_KEY } }); log('  OPENAI_API_KEY works: ' + o.status); }

log('\n== 5. Yemot account');
const tok = String(main.YEMOT_TOKEN || '').trim() || (main.YEMOT_API_USERNAME + ':' + main.YEMOT_API_PASSWORD);
const s = await j('https://www.call2all.co.il/ym/api/GetSession?token=' + encodeURIComponent(tok));
const hide = /token|pass|phone|mail|name|id$|address|ip/i;
for (const [k, v] of Object.entries(s.body || {})) if (!hide.test(k)) log('  ' + k + ' = ' + (typeof v === 'object' ? JSON.stringify(v).slice(0, 200) : v));

log('\n== 6. Song engine (extension 4): last results in the log');
try { const { execSync } = await import('node:child_process'); log(execSync("journalctl -u yemot-main --since '-3 days' -q -o cat --no-pager | grep -E 'SONG.*(SONG_READY|SONG_FAILED|PROVIDER_HEALTH|MUSIC_PROVIDER_FAILED|delivered)' | tail -8", { encoding: 'utf8' })); } catch {}

log('\n== 7. Live server state (read-only)');
try {
  const { execSync } = await import('node:child_process');
  const sh = c => { try { return execSync(c, { encoding: 'utf8', timeout: 20000 }).trim(); } catch (e) { return 'ERR ' + String(e.message).slice(0, 100); } };
  log('  main running: ' + sh('cat /opt/yemot/.running-main') + ' | main HEAD ' + sh('git -C /opt/yemot/main rev-parse --short HEAD'));
  log('  ext2 HEAD: ' + sh('git -C /opt/yemot/ext2 log --oneline -1') );
  log('  ext2 has yt-dlp fallback: ' + sh('grep -c ytdlpSearchVideos /opt/yemot/ext2/youtube-ivr.js'));
  log('  ext2 process started: ' + sh('systemctl show yemot-ext2 -p ActiveEnterTimestamp --value') + ' | last ext2 commit time: ' + sh('git -C /opt/yemot/ext2 log -1 --format=%ci'));
  log('  services: ' + sh("for s in yemot-main yemot-ext2 caddy; do printf '%s=%s ' $s $(systemctl is-active $s); done"));
  log('  timers: ' + sh("systemctl list-timers --all --no-legend | grep -oE 'yemot[a-z0-9-]*\\.timer' | sort -u | tr '\\n' ' '"));
  log('  netplan files: ' + sh('ls /etc/netplan/') + ' | sha ' + sh('sha256sum /etc/netplan/*.yaml | cut -c1-12'));
  log('  netplan has new IP: ' + sh('grep -c 176.97.205.41 /etc/netplan/50-cloud-init.yaml') + ' old IP: ' + sh('grep -c 88.214.55.82 /etc/netplan/50-cloud-init.yaml'));
  log('  cloud-init network disabled file: ' + sh('ls /etc/cloud/cloud.cfg.d/ | grep -i network'));
  log('  addresses on server: ' + sh("ip -4 -o addr show scope global | awk '{print $4}' | tr '\\n' ' '"));
  log('  PUBLIC_BASE_URL main: ' + (main.PUBLIC_BASE_URL || '-') + ' | ext2: ' + (ext2.PUBLIC_BASE_URL || '-'));
  log('  caddy hosts: ' + sh("grep -oE '[a-z0-9.-]+sslip\\.io' /etc/caddy/Caddyfile | sort -u | tr '\\n' ' '"));
  for (const ext of ['1', '2', '3', '4', '7']) {
    const r = await j('https://www.call2all.co.il/ym/api/GetTextFile?token=' + encodeURIComponent(tok) + '&what=' + encodeURIComponent('ivr2:/' + ext + '/ext.ini'));
    const c = String(r.body?.contents || '');
    const hosts = [...new Set((c.match(/https?:\/\/[a-z0-9.-]+/gi) || []).map(h => h.replace(/^https?:\/\//, '')))];
    log('  Yemot ext ' + ext + ': ' + (c.match(/^type=.*/m)?.[0] || '?') + ' -> ' + (hosts.join(', ') || 'no link'));
  }
  for (const h of ['main.176-97-205-41.sslip.io', 'ext2.176-97-205-41.sslip.io', 'main.88-214-55-82.sslip.io']) { const r = await j('https://' + h + '/'); log('  https ' + h + ' -> ' + r.status); }
  const { searchYouTubeVideos } = await import('/opt/yemot/ext2/youtube-ivr.js').catch(e => ({ e }));
  const t0 = Date.now();
  if (searchYouTubeVideos) {
    const { ytdlpSearchVideos } = await import('/opt/yemot/ext2/youtube-ivr.js');
    const r = ytdlpSearchVideos ? await ytdlpSearchVideos('שירי שבת', { count: 5 }).catch(e => ({ err: e.message })) : { err: 'no export' };
    log('  ext2 yt-dlp search test: ' + (r.err || ((r.items || r).length + ' results, first: ' + String((r.items || r)[0]?.snippet?.title || (r.items || r)[0]?.title || '').slice(0, 60))) + ' in ' + (Date.now() - t0) + 'ms');
  }
  const { ytdlpSearch } = await import('/opt/yemot/main/ext3-brain.js');
  const t1 = Date.now(); const m = await ytdlpSearch(['שירי שבת'], { count: 5 }).catch(e => ({ err: e.message }));
  log('  main yt-dlp search test: ' + (m.err || (m.length + ' results, first: ' + String(m[0]?.title || '').slice(0, 60))) + ' in ' + (Date.now() - t1) + 'ms');
} catch (e) { log('  state check failed: ' + e.message); }

mkdirSync('/var/lib/yemot-report', { recursive: true, mode: 0o700 });
const name = randomBytes(12).toString('hex');
writeFileSync('/var/lib/yemot-report/' + name + '.txt', out.join('\n'), { mode: 0o600 });
console.log('AUDIT READY: /owner-report/' + name);
console.log('code: ' + name.match(/.{1,4}/g).join(' '));
