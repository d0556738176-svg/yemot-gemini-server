// Owner, 19.11: "is it open now?" answered from the map's own opening hours
// (OpenStreetMap opening_hours), computed for this minute in Israel, instead
// of leaving a raw "Su-Th 08:00-22:00" for the model to guess from.
// Covers the forms used in Israel: day ranges, several time ranges, "off",
// "24/7" and hours past midnight. Anything else is "unknown", never a guess.

const DAYS = ['Su', 'Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa'];
const HE_DAY = ['ראשון', 'שני', 'שלישי', 'רביעי', 'חמישי', 'שישי', 'שבת'];

/** Israel's weekday (0 = Sunday) and minute of the day for a moment. */
export function israelClock(now = new Date()) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: 'Asia/Jerusalem', weekday: 'short', hour: 'numeric', minute: 'numeric', hourCycle: 'h23' })
    .formatToParts(now).map(p => [p.type, p.value]));
  return { day: DAYS.indexOf(String(parts.weekday).slice(0, 2)), minute: Number(parts.hour) * 60 + Number(parts.minute) };
}

function daySet(text) {
  const set = new Set();
  for (const part of String(text).split(',').map(s => s.trim()).filter(Boolean)) {
    const m = part.match(/^([A-Z][a-z])(?:\s*-\s*([A-Z][a-z]))?$/);
    if (!m) return null;
    const a = DAYS.indexOf(m[1]), b = m[2] ? DAYS.indexOf(m[2]) : a;
    if (a < 0 || b < 0) return null;
    for (let d = a; ; d = (d + 1) % 7) { set.add(d); if (d === b) break; }
  }
  return set.size ? set : null;
}
const mins = t => { const m = String(t).match(/^(\d{1,2}):(\d{2})$/); return m ? Number(m[1]) * 60 + Number(m[2]) : null; };

/** { days: Map(day -> [[from, to]] | 'off'), ok } — to > 1440 means past midnight. */
export function parseOpeningHours(text) {
  const s = String(text || '').trim();
  if (!s) return null;
  if (/^24\s*\/\s*7$/.test(s)) return { always: true };
  const days = new Map();
  for (let rule of s.split(/\s*(?:;|\|\|)\s*/).filter(Boolean)) {
    rule = rule.trim();
    if (/^(?:PH|SH)\b/.test(rule)) continue; // holidays: not modelled, said as unknown elsewhere
    let set = new Set([0, 1, 2, 3, 4, 5, 6]), body = rule;
    const m = rule.match(/^((?:[A-Z][a-z](?:\s*-\s*[A-Z][a-z])?)(?:\s*,\s*[A-Z][a-z](?:\s*-\s*[A-Z][a-z])?)*)(?:\s*,\s*PH)?\s*(.*)$/);
    if (m && m[1]) { const d = daySet(m[1]); if (!d) return null; set = d; body = m[2].trim(); }
    if (!body) body = '00:00-24:00';
    let value;
    if (/^(?:off|closed)$/i.test(body)) value = 'off';
    else {
      value = [];
      for (const r of body.split(/\s*,\s*/)) {
        const t = r.match(/^(\d{1,2}:\d{2})\s*-\s*(\d{1,2}:\d{2})\+?$/);
        if (!t) return null; // sunset, "by appointment", comments: unknown
        let a = mins(t[1]), b = mins(t[2]);
        if (a === null || b === null) return null;
        if (b <= a) b += 1440;
        value.push([a, b]);
      }
    }
    for (const d of set) days.set(d, value); // a later rule replaces an earlier one
  }
  return days.size ? { days } : null;
}

const hhmm = m => { m = ((m % 1440) + 1440) % 1440; return String(Math.floor(m / 60)).padStart(2, '0') + ':' + String(m % 60).padStart(2, '0'); };

/**
 * State at this moment: { state: 'open'|'closed'|'unknown', until, opensAt, opensDay, today }.
 * until/opensAt are "HH:MM"; opensDay is a Hebrew day name when it opens on another day.
 */
export function openState(text, now = new Date()) {
  const p = parseOpeningHours(text);
  if (!p) return { state: 'unknown' };
  if (p.always) return { state: 'open', always: true, today: 'פתוח תמיד, עשרים וארבע שעות' };
  const { day, minute } = israelClock(now);
  const ranges = d => { const v = p.days.get(((d % 7) + 7) % 7); return v === 'off' ? [] : v || null; };
  // Still open from yesterday's late hours?
  const y = ranges(day - 1) || [];
  for (const [a, b] of y) if (b > 1440 && minute < b - 1440) return { state: 'open', until: hhmm(b), today: todayText(ranges(day)) };
  const t = ranges(day);
  if (t === null) return { state: 'unknown' };
  for (const [a, b] of t) if (minute >= a && minute < b) return { state: 'open', until: hhmm(b), today: todayText(t) };
  const later = t.filter(([a]) => a > minute).sort((x, z) => x[0] - z[0])[0];
  if (later) return { state: 'closed', opensAt: hhmm(later[0]), today: todayText(t) };
  for (let k = 1; k <= 7; k++) {
    const r = ranges(day + k);
    if (r === null) return { state: 'closed', today: todayText(t) };
    if (r.length) return { state: 'closed', opensAt: hhmm(r[0][0]), opensDay: k === 1 ? 'מחר' : 'ביום ' + HE_DAY[(day + k) % 7], today: todayText(t) };
  }
  return { state: 'closed', today: todayText(t) };
}
function todayText(r) {
  if (!r) return '';
  if (!r.length) return 'היום סגור';
  return 'היום ' + r.map(([a, b]) => 'מ-' + hhmm(a) + ' עד ' + hhmm(b)).join(' ו');
}

/** One spoken line for a place's hours now (Hebrew), or '' when unknown. */
export function openLine(text, now = new Date(), spoken = x => x) {
  const s = openState(text, now);
  if (s.state === 'open') return s.always ? 'פתוח עכשיו, עשרים וארבע שעות ביממה' : 'פתוח עכשיו, עד ' + spoken(s.until);
  if (s.state === 'closed') return 'סגור עכשיו' + (s.opensAt ? ', ייפתח ' + (s.opensDay ? s.opensDay + ' ב' : 'היום ב') + spoken(s.opensAt) : '');
  return '';
}
