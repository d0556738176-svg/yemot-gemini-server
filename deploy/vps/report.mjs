// Owner's call report for extensions 1 and 3 (18.11): what callers asked, what
// they heard, and how each turn went (route, time, failures). Read-only: it
// changes nothing and restarts nothing.
//   node /opt/yemot/main/deploy/vps/report.mjs [days]
// It writes the report to a private file with a long random name and prints
// its address; the address works for 2 hours, then the file is ignored and
// deleted on the next run. No keys or passwords are printed or written.
import { readFileSync, writeFileSync, mkdirSync, readdirSync, statSync, unlinkSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';

const DAYS = Math.max(1, Math.min(14, Number(process.argv[2]) || 5));
const DIR = '/var/lib/yemot-report';
const env = {};
for (const line of readFileSync('/opt/yemot/main.env', 'utf8').split('\n')) {
  const m = line.match(/^([A-Z0-9_]+)="(.*)"$/); if (m) env[m[1]] = m[2].replace(/\\"/g, '"').replace(/\\\\/g, '\\');
}
const token = String(env.YEMOT_TOKEN || '').trim() || (env.YEMOT_API_USERNAME && env.YEMOT_API_PASSWORD ? env.YEMOT_API_USERNAME + ':' + env.YEMOT_API_PASSWORD : '');
const API = 'https://www.call2all.co.il/ym/api';
const since = Date.now() - DAYS * 86400000;
const il = t => new Date(t).toLocaleString('he-IL', { timeZone: 'Asia/Jerusalem', hour12: false });
const out = [];
const say = s => out.push(s);

say('דוח שיחות שלוחות 1 ו-3, ' + DAYS + ' ימים אחרונים. נוצר ' + il(Date.now()));
say('');

// ---- A. The conversations themselves (caller memory in the Yemot account) ----
let callers = 0, turns = 0;
if (token) {
  try {
    const u = new URL(API + '/GetIVR2Dir'); u.searchParams.set('token', token); u.searchParams.set('path', 'ivr2:/ai_memory');
    const j = await (await fetch(u, { signal: AbortSignal.timeout(20000) })).json();
    const names = [...(j.files || []), ...(j.ini || []), ...(j.html || [])].map(f => f.name || f.fileName || '').filter(n => /\.json$/i.test(n));
    for (const name of names) {
      const d = new URL(API + '/DownloadFile'); d.searchParams.set('token', token); d.searchParams.set('path', 'ivr2:/ai_memory/' + name);
      let mem = null;
      try { mem = JSON.parse(await (await fetch(d, { signal: AbortSignal.timeout(15000) })).text()); } catch { continue; }
      const recent = (mem?.entries || []).filter(e => Date.parse(e.time || 0) >= since);
      if (!recent.length) continue;
      callers++;
      say('==================== מתקשר ' + name.replace(/\.json$/i, '') + ' (' + recent.length + ' תורות) ====================');
      if (mem.prefs?.length) say('הוראות קבועות: ' + mem.prefs.map(p => p.text || p).join(' | '));
      let lastCall = '';
      for (const e of recent) {
        turns++;
        if (e.callId !== lastCall) { say('--- שיחה ' + (e.callId || '?') + ' ---'); lastCall = e.callId; }
        say('[' + il(e.time) + '] שאל: ' + String(e.user || '').slice(0, 400));
        say('    ענה: ' + String(e.gemini || '').replace(/\s*¶\s*/g, '. ').slice(0, 1500));
        if (e.ref?.type) say('    (פריט: ' + e.ref.type + ' ' + String(e.ref.title || e.ref.topic || '').slice(0, 100) + ')');
      }
      say('');
    }
  } catch (e) { say('!! לא הצלחתי לקרוא את זיכרון השיחות: ' + String(e?.message || e).slice(0, 120)); }
} else say('!! אין פרטי גישה לימות בקובץ ההגדרות');

// ---- B. How each turn went (server log) ----
const j = spawnSync('journalctl', ['-u', 'yemot-main', '--since', DAYS + ' days ago', '-o', 'short-iso', '--no-pager', '-q'], { encoding: 'utf8', maxBuffer: 512 * 1024 * 1024 });
const lines = String(j.stdout || '').split('\n');
const keep = /\[(REPLY_PREVIEW|BRANCH1_ROUTER|ZMANIM|PLACE|E2E_SELFTEST)\]|\[EXT3_BRAIN\] (plan|web research|turn failed|no answer|answer models busy|planner unavailable|web answer not written|web search found nothing)|\[CALL_FLOW\] (reply_ready|long_answer_trimmed)|\[ASR|\[BRANCH1_WEB_SYNTH\] answered|transcri/i;
const counts = new Map(), errors = new Map(), latency = [];
const picked = [];
for (const l of lines) {
  const tag = (l.match(/\[([A-Z0-9_ ]+)\]\s*([a-z_ ]{0,40})/i) || [])[0];
  if (tag) counts.set(tag.trim(), (counts.get(tag.trim()) || 0) + 1);
  const ms = l.match(/reply_ready.*elapsedMs:\s*(\d+)/); if (ms) latency.push(Number(ms[1]));
  if (/warn|error|fail|crash|unavailable|HTTP [45]\d\d|timeout|timed out/i.test(l) && !keep.test(l)) {
    const k = l.replace(/^\S+\s+\S+\s+\S+\s+/, '').replace(/\d{4,}|[0-9a-f]{8,}/gi, '#').slice(0, 200);
    errors.set(k, (errors.get(k) || 0) + 1);
  }
  if (keep.test(l)) picked.push(l.replace(/^(\S+)\s+\S+\s+\S+\s+/, '$1 ').slice(0, 900));
}
latency.sort((a, b) => a - b);
const q = p => latency.length ? latency[Math.min(latency.length - 1, Math.floor(p * latency.length))] : 0;
say('==================== סיכום יומן השרת ====================');
say('תורות שנענו: ' + latency.length + ', זמן תשובה: חציון ' + q(0.5) + 'ms, 90% ' + q(0.9) + 'ms, מקסימום ' + (latency.at(-1) || 0) + 'ms');
say('מתקשרים בדוח: ' + callers + ', תורות: ' + turns);
say('');
say('---- תקלות ואזהרות (מספר פעמים) ----');
for (const [k, n] of [...errors].sort((a, b) => b[1] - a[1]).slice(0, 80)) say(n + 'x ' + k);
say('');
say('---- תגים ----');
for (const [k, n] of [...counts].sort((a, b) => b[1] - a[1]).slice(0, 60)) say(n + 'x ' + k);
say('');
say('---- מהלך התורות (נתב, תכנון, זמנים) ----');
for (const l of picked.slice(-2500)) say(l);

// ---- write, and remove old reports ----
mkdirSync(DIR, { recursive: true, mode: 0o700 });
for (const f of readdirSync(DIR)) { try { if (Date.now() - statSync(DIR + '/' + f).mtimeMs > 2 * 3600 * 1000) unlinkSync(DIR + '/' + f); } catch {} }
const name = randomBytes(12).toString('hex');
writeFileSync(DIR + '/' + name + '.txt', out.join('\n'), { mode: 0o600 });
const host = String(env.PUBLIC_BASE_URL || '').replace(/\/+$/, '');
console.log('');
console.log('REPORT READY (' + Math.round(out.join('\n').length / 1024) + ' KB, valid 2 hours):');
console.log(host + '/owner-report/' + name);
console.log('code in groups: ' + name.match(/.{1,4}/g).join(' '));
