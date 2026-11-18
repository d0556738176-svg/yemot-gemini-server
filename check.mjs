// Read-only live check of the place tools in the RUNNING code (/opt/yemot/main).
// Nothing is restarted, saved or called. Output goes to a 2-hour private report.
import { writeFileSync, mkdirSync, readFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
const M = '/opt/yemot/main/';
const { zmanimFacts, nearbyFacts } = await import(M + 'place-tools.js');
const { ext3Turn } = await import(M + 'ext3-brain.js');
const out = [];
const log = { info: (...a) => out.push('  log ' + JSON.stringify(a).slice(0, 300)), warn: (...a) => out.push('  WARN ' + JSON.stringify(a).slice(0, 300)) };
const noLlm = async () => { throw Object.assign(new Error('no model in this check'), { status: 503 }); };
const asks = [
  'מתי סוף זמן קריאת שמע של הגרא במשוב עוצם',
  'איפה הבית כנסת הקרוב ביותר לחוף הנפרד באשקלון',
  'מתי השקיעה היום בבית שמש',
  'מתי צאת השבת בבני ברק',
  'מתי הדלקת נרות בירושלים',
  'איפה יש בית מרקחת קרוב לכיכר ציון בירושלים',
  'איפה יש מקווה ליד רחוב נחל הקישון בבית שמש',
  'מתי סוף זמן תפילה לפי המגן אברהם מחר בקריית גת'
];
for (const q of asks) {
  const t = Date.now();
  try {
    const r = await ext3Turn({ utterance: q, now: new Date().toLocaleString('he-IL', { timeZone: 'Asia/Jerusalem' }), voice: 'female' }, { llm: noLlm, log, webSearch: async () => [], retryPauseMs: 0 });
    out.push('Q: ' + q + '\n  intent=' + r.intent + ' ms=' + (Date.now() - t) + '\n  A: ' + r.reply);
  } catch (e) { out.push('Q: ' + q + '\n  CRASH ' + String(e?.stack || e).slice(0, 300)); }
}
const f = await nearbyFacts({ kindText: 'בית כנסת', place: 'החוף הנפרד', town: 'אשקלון' }, { log }).catch(e => ({ err: String(e) }));
out.push('\nRAW nearby: ' + JSON.stringify({ loc: f.loc, items: f.items, err: f.err }, null, 1).slice(0, 3000));
const z = await zmanimFacts({ town: 'עוצם', utterance: 'היום' }, { log }).catch(e => ({ err: String(e) }));
out.push('\nRAW zmanim: ' + JSON.stringify({ loc: z?.loc, date: z?.date, source: z?.source, times: z?.times }, null, 1));
const text = 'running ' + readFileSync('/opt/yemot/.running-main', 'utf8') + '\n' + out.join('\n');
mkdirSync('/var/lib/yemot-report', { recursive: true, mode: 0o700 });
const name = randomBytes(12).toString('hex');
writeFileSync('/var/lib/yemot-report/' + name + '.txt', text, { mode: 0o600 });
console.log('CHECK DONE: ' + name.match(/.{1,4}/g).join(' '));
