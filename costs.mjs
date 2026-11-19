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

mkdirSync('/var/lib/yemot-report', { recursive: true, mode: 0o700 });
const name = randomBytes(12).toString('hex');
writeFileSync('/var/lib/yemot-report/' + name + '.txt', out.join('\n'), { mode: 0o600 });
console.log('AUDIT READY: /owner-report/' + name);
console.log('code: ' + name.match(/.{1,4}/g).join(' '));
