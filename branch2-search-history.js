// Extension 2 search history (owner, 18.11): every search a caller makes is
// kept, newest first, so key 4 at the start of the extension reads them back
// 20 at a time and a key press runs the same search again.
// Kept in Yemot's storage (like the other extension 2 records), one file per
// caller, so it survives restarts and server moves. Never throws.

export const HISTORY_MAX = 500;
export const historyPath = phone => 'ivr2:/2/youtubejobs/history/' + String(phone || '').replace(/[^0-9]/g, '') + '.json';
const usablePhone = phone => String(phone || '').replace(/[^0-9]/g, '').length >= 5;
const same = (a, b) => String(a || '').replace(/[^\p{L}\p{N}]+/gu, ' ').trim().toLowerCase() === String(b || '').replace(/[^\p{L}\p{N}]+/gu, ' ').trim().toLowerCase();

// The list, newest first: [{ q, at, n }] (n = results found that time).
export async function readHistory(phone, store) {
  if (!usablePhone(phone)) return [];
  try {
    const data = await store.read(historyPath(phone));
    return Array.isArray(data?.items) ? data.items.filter(x => x && String(x.q || '').trim()) : [];
  } catch { return []; }
}

// The same search again moves to the top instead of appearing twice.
export async function addToHistory(phone, query, store, { results = null, now = Date.now() } = {}) {
  const q = String(query || '').replace(/\s+/g, ' ').trim().slice(0, 200);
  if (!q || !usablePhone(phone)) return null;
  try {
    const items = (await readHistory(phone, store)).filter(x => !same(x.q, q));
    items.unshift({ q, at: new Date(now).toISOString(), ...(results != null ? { n: results } : {}) });
    const data = { items: items.slice(0, HISTORY_MAX) };
    await store.write(historyPath(phone), data);
    return data.items;
  } catch { return null; }
}

// What is read for one page of the history: "1, <search>. 2, <search>." and
// how long ago it was, short.
export function historyPageText(items, start, size = 20, { now = Date.now(), spoken = x => x } = {}) {
  const page = items.slice(start, start + size);
  return page.map((x, i) => (start + i + 1) + ', ' + spoken(x.q) + (ago(x.at, now) ? ', ' + ago(x.at, now) : '') + ',').join(' ');
}

function ago(at, now) {
  const t = Date.parse(at || '');
  if (!Number.isFinite(t)) return '';
  const min = Math.max(0, Math.round((now - t) / 60000));
  if (min < 2) return 'עכשיו';
  if (min < 60) return 'לפני ' + min + ' דקות';
  const h = Math.round(min / 60);
  if (h < 24) return h === 1 ? 'לפני שעה' : h === 2 ? 'לפני שעתיים' : 'לפני ' + h + ' שעות';
  const d = Math.round(h / 24);
  if (d < 30) return d === 1 ? 'אתמול' : d === 2 ? 'לפני יומיים' : 'לפני ' + d + ' ימים';
  const m = Math.round(d / 30);
  return m <= 1 ? 'לפני חודש' : m === 2 ? 'לפני חודשיים' : 'לפני ' + m + ' חודשים';
}
