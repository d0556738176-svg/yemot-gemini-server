// Exchange rates from the Bank of Israel itself (owner, 28.11: exact and up to
// date, without search credits). "How much is the dollar today" was answered
// from mixed web pages (a live market quote and a bank's reverse rate in one
// answer); the official representative rate is one request, cached 30 minutes.
const NAMES = [
  ['USD', /(?:דולר(?!\s*(?:קנדי|אוסטרלי))|\$)/u, 'הדולר'],
  ['EUR', /(?:יורו|אירו)/u, 'היורו'],
  ['GBP', /(?:לירה שטרלינג|פאונד|שטרלינג)/u, 'הלירה שטרלינג'],
  ['CHF', /פרנק/u, 'הפרנק השווייצרי'],
  ['JPY', /(?:^|\s)ין(?:\s|$)/u, 'הין היפני'],
  ['CAD', /דולר קנדי/u, 'הדולר הקנדי'],
  ['AUD', /דולר אוסטרלי/u, 'הדולר האוסטרלי']
];
export const RATE_QUESTION = /(?:שער|כמה עולה|כמה שווה|מה המחיר של|מחיר ה?)(?:\s+ה?)?(?:דולר|יורו|אירו|לירה שטרלינג|פאונד|פרנק|ין)|(?:דולר|יורו|אירו)\s+(?:היום|עכשיו|כרגע)/u;
let cache = null;
async function rates(fetchImpl) {
  if (cache && Date.now() - cache.at < 30 * 60000) return cache.list;
  const r = await fetchImpl('https://boi.org.il/PublicApi/GetExchangeRates?asJson=true', { signal: AbortSignal.timeout(5000), headers: { accept: 'application/json' } });
  if (!r.ok) throw new Error('Bank of Israel HTTP ' + r.status);
  const j = await r.json();
  const list = (j?.exchangeRates || []).map(x => ({ key: String(x.key || '').toUpperCase(), rate: Number(x.currentExchangeRate), change: Number(x.currentChange), unit: Number(x.unit) || 1, at: String(x.lastUpdate || '') })).filter(x => x.key && Number.isFinite(x.rate));
  if (!list.length) throw new Error('no rates');
  cache = { at: Date.now(), list };
  return list;
}
const say = n => String(Math.round(n * 1000) / 1000).replace('.', ' נקודה ');
/** The spoken answer, or '' when the question is not about these currencies or the bank did not answer. */
export async function rateAnswer(text, { fetchImpl = fetch, log = console } = {}) {
  const t = String(text || '');
  if (!RATE_QUESTION.test(t)) return '';
  const asked = NAMES.filter(([, rx]) => rx.test(t));
  if (!asked.length) return '';
  let list;
  try { list = await rates(fetchImpl); } catch (e) { log.warn?.('[BOI_RATES] unavailable', String(e?.message || e).slice(0, 80)); return ''; }
  const parts = [];
  for (const [key, , name] of asked.filter((x, i, a) => !(x[0] === 'USD' && a.some(y => y[0] === 'CAD' || y[0] === 'AUD')))) {
    const x = list.find(r => r.key === key);
    if (!x) continue;
    const per = x.rate / x.unit;
    const day = x.at ? new Intl.DateTimeFormat('he-IL', { timeZone: 'Asia/Jerusalem', day: 'numeric', month: 'long' }).format(new Date(x.at)) : '';
    parts.push('השער היציג של ' + name + ' הוא ' + say(per) + ' שקלים' + (day ? ', כפי שפרסם בנק ישראל ב' + day : '') +
      (Number.isFinite(x.change) && x.change ? ', ' + (x.change > 0 ? 'עלייה' : 'ירידה') + ' של ' + say(Math.abs(x.change)) + ' אחוז' : '') + '.');
  }
  if (!parts.length) return '';
  log.info?.('[BOI_RATES] official rate answered', { currencies: asked.map(a => a[0]) });
  return parts.join(' ') + ' בבנקים ובצ׳יינג׳ השער לקנייה ולמכירה קצת שונה מהשער היציג.';
}
