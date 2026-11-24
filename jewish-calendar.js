// Owner, 24.11: "when is Chanukah this year?" got the wrong day from a model.
// The dates of the holidays and fasts come from Hebcal (Israel), computed.
const HOLIDAYS = [
  ['חנוכה', /חנוכה/u], ['פורים קטן', /פורים קטן/u], ['שושן פורים', /שושן פורים/u], ['תענית אסתר', /תענית אסתר/u], ['פורים', /פורים/u],
  ['ערב פסח', /ערב פסח/u], ['פסח', /פסח/u], ['שבועות', /שבועות/u], ['ראש השנה', /ראש השנה/u], ['יום כיפור', /יום (?:ה)?כיפור(?:ים)?/u],
  ['סוכות', /סוכות/u], ['שמיני עצרת', /שמחת תורה|שמיני עצרת/u], ['הושענא רבה', /הושענא רבה/u], ['ט״ו בשבט', /ט["״]?ו בשבט|טו בשבט/u],
  ['ל״ג בעומר', /ל["״]?ג בעומר|לג בעומר/u], ['תשעה באב', /תשעה באב|ט["״]?ב באב/u], ['צום גדליה', /צום גדליה/u], ['עשרה בטבת', /עשרה בטבת|י["״]? בטבת/u],
  ['י״ז בתמוז', /י["״]?ז בתמוז|שבעה עשר בתמוז/u], ['יום ירושלים', /יום ירושלים/u], ['יום העצמאות', /יום העצמאות/u], ['יום הזיכרון', /יום הזיכרון|יום הזכרון/u],
  ['יום השואה', /יום השואה/u], ['ראש חודש', /ראש חודש/u], ['תענית בכורות', /תענית בכורות/u], ['פסח שני', /פסח שני/u],
];
const ASK = /(?:מתי|באיזה (?:תאריך|יום)|באיזו? תאריך|איזה יום|כמה (?:ימים|זמן) (?:נשאר|נשארו|עד)|עוד כמה ימים|מה התאריך של|תאריך של)/u;
const plain = t => String(t || '').replace(/[֑-ׇ]/g, '').replace(/[׳']/g, '׳').trim();
export function holidayAsked(text) {
  const t = String(text || '');
  if (!ASK.test(t)) return null;
  for (const [name, re] of HOLIDAYS) if (re.test(t)) return name;
  return null;
}
const dayName = d => new Intl.DateTimeFormat('he-IL', { timeZone: 'Asia/Jerusalem', weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' }).format(new Date(d + 'T12:00:00'));
const hebDate = d => new Intl.DateTimeFormat('he-IL-u-ca-hebrew', { timeZone: 'Asia/Jerusalem', day: 'numeric', month: 'long' }).format(new Date(d + 'T12:00:00'));
export async function answerHoliday(text, { fetchImpl = fetch, now = new Date(), timeoutMs = 5000 } = {}) {
  const name = holidayAsked(text);
  if (!name) return null;
  const start = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Jerusalem' }).format(now);
  const end = new Date(now.getTime() + 400 * 86400000).toISOString().slice(0, 10);
  const u = 'https://www.hebcal.com/hebcal?v=1&cfg=json&maj=on&min=on&mod=on&nx=on&ss=on&mf=on&c=off&i=on&lg=he&start=' + start + '&end=' + end;
  const j = await (await fetchImpl(u, { signal: AbortSignal.timeout(timeoutMs) })).json();
  const items = (j?.items || []).map(x => ({ date: String(x.date).slice(0, 10), title: plain(x.hebrew || x.title) })).filter(x => x.date >= start);
  const key = plain(name).replace(/["״]/g, '');
  const match = items.filter(x => x.title.replace(/["״]/g, '').includes(key.split(' ')[0] === 'ראש' ? key : key) && !(name === 'פורים' && /קטן|שושן|ערב/u.test(x.title)) && !(name === 'פסח' && /שני|ערב/u.test(x.title)));
  if (!match.length) return null;
  const first = match[0], last = match[match.length - 1];
  const daysTo = Math.round((Date.parse(first.date) - Date.parse(start)) / 86400000);
  const soon = daysTo === 0 ? ' זה היום.' : daysTo === 1 ? ' זה מחר.' : ' עוד ' + daysTo + ' ימים.';
  if (name === 'חנוכה') {
    const nights = match.filter(x => /נר/u.test(x.title));
    const end8 = match.find(x => /יום ח/u.test(x.title)) || nights[nights.length - 1] || last;
    return 'את הנר הראשון של חנוכה מדליקים ב' + dayName(nights[0]?.date || first.date) + ' בערב, ערב כ״ה בכסלו.' + soon + ' היום האחרון של חנוכה, זאת חנוכה, הוא ' + dayName(end8.date) + '.';
  }
  if (name === 'ראש חודש') {
    const group = match.filter(x => x.title === first.title);
    return first.title + ' יחול ב' + group.map(x => dayName(x.date)).join(' וב') + '.' + soon;
  }
  const span = ['פסח', 'סוכות'].includes(name) ? match.filter(x => !/ערב/u.test(x.title)) : [first];
  return name + ' יחול ב' + dayName(span[0].date) + ', ' + hebDate(span[0].date) + '.' + soon + (span.length > 1 ? ' החג נמשך עד ' + dayName(span[span.length - 1].date) + '.' : '') + (['פסח', 'סוכות', 'שבועות', 'ראש השנה', 'יום כיפור'].includes(name) ? ' החג נכנס בערב שלפני כן.' : '');
}

// "What is this week's parasha?", "the haftarah", "today's daf yomi" (Israel).
const BOOKS = { Genesis: 'בראשית', Exodus: 'שמות', Leviticus: 'ויקרא', Numbers: 'במדבר', Deuteronomy: 'דברים', Joshua: 'יהושע', Judges: 'שופטים', 'I Samuel': 'שמואל א', 'II Samuel': 'שמואל ב', 'I Kings': 'מלכים א', 'II Kings': 'מלכים ב', Isaiah: 'ישעיהו', Jeremiah: 'ירמיהו', Ezekiel: 'יחזקאל', Hosea: 'הושע', Joel: 'יואל', Amos: 'עמוס', Obadiah: 'עובדיה', Jonah: 'יונה', Micah: 'מיכה', Nahum: 'נחום', Habakkuk: 'חבקוק', Zephaniah: 'צפניה', Haggai: 'חגי', Zechariah: 'זכריה', Malachi: 'מלאכי' };
function spokenRef(ref) {
  return String(ref || '').split('|')[0].split(';').map(p => p.trim()).filter(Boolean).map(p => {
    const m = p.match(/^(.+?) (\d+):(\d+)(?:-(?:(\d+):)?(\d+))?$/);
    if (!m) return p;
    const book = BOOKS[m[1]] || m[1];
    return book + ' פרק ' + m[2] + ' פסוק ' + m[3] + (m[5] ? ' עד ' + (m[4] && m[4] !== m[2] ? 'פרק ' + m[4] + ' פסוק ' : 'פסוק ') + m[5] : '');
  }).join(', ועוד ');
}
export function torahCalendarAsked(text) {
  const t = String(text || '');
  if (/(?:פרשת|פרשה)\s*(?:ה)?שבוע|איזו פרשה|איזה פרשה|מה הפרשה|פרשת השבוע|קוראים השבוע|קוראים בשבת|ההפטרה|הפטרה|מפטירים/u.test(t)) return /(?:הבא|הבאה|בעוד שבוע|שבוע הבא)/u.test(t) ? 'parsha-next' : /(?:הפטרה|ההפטרה|מפטירים)/u.test(t) ? 'haftarah' : 'parsha';
  if (/(?:ה?דף ה?יומי|דף יומי)/u.test(t) && !/(?:שיעור|תשמיע|להשמיע|לשמוע|תוריד|הקלטה)/u.test(t)) return /מחר/u.test(t) ? 'daf-tomorrow' : 'daf';
  return null;
}
export async function answerTorahCalendar(text, { fetchImpl = fetch, now = new Date(), timeoutMs = 5000 } = {}) {
  const kind = torahCalendarAsked(text);
  if (!kind) return null;
  const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Jerusalem' }).format(now);
  const end = new Date(now.getTime() + 16 * 86400000).toISOString().slice(0, 10);
  const u = 'https://www.hebcal.com/hebcal?v=1&cfg=json&s=on&i=on&leyning=on&F=on&lg=he&start=' + today + '&end=' + end;
  const j = await (await fetchImpl(u, { signal: AbortSignal.timeout(timeoutMs) })).json();
  const items = (j?.items || []).map(x => ({ date: String(x.date).slice(0, 10), cat: x.category, title: plain(x.hebrew || x.title), leyning: x.leyning || {} }));
  if (kind.startsWith('daf')) {
    const want = kind === 'daf' ? today : new Date(Date.parse(today) + 86400000).toISOString().slice(0, 10);
    const d = items.find(x => x.cat === 'dafyomi' && x.date === want);
    return d ? (kind === 'daf' ? 'הדף היומי היום הוא ' : 'הדף היומי מחר הוא ') + d.title + '.' : null;
  }
  const weeks = items.filter(x => x.cat === 'parashat');
  const p = kind === 'parsha-next' ? weeks[1] : weeks[0];
  if (!p) {
    const hol = items.find(x => x.cat === 'holiday' && x.date >= today);
    return hol ? 'בשבת הקרובה לא קוראים פרשה רגילה, כי זה ' + hol.title + '.' : null;
  }
  const h = p.leyning.haftarah ? spokenRef(p.leyning.haftarah) : '';
  const special = String(p.leyning.haftarah || '').split('|')[1] ? ' (הפטרה מיוחדת: ' + String(p.leyning.haftarah).split('|')[1].trim().replace('Chanukah', 'חנוכה').replace('Day', 'יום').replace('(on Shabbat)', 'בשבת') + ')' : '';
  if (kind === 'haftarah') return 'ההפטרה של ' + p.title + ', ב' + dayName(p.date) + ', היא ב' + h + special + '.';
  return (kind === 'parsha-next' ? 'בשבת שאחרי, ' : 'פרשת השבוע היא ') + p.title.replace(/^פרשת\s+/u, kind === 'parsha-next' ? 'קוראים את פרשת ' : '') + ', שנקראת ב' + dayName(p.date) + '.' + (h ? ' ההפטרה: ' + h + special + '.' : '') + ' אם תרצה, אספר לך על מה הפרשה.';
}
