// Extension 2, many downloads at once (owner, 18.11):
//  - "0 and #" in the results = download every result heard so far;
//  - key 4 there = only some of them, typed one after another, e.g. 123420#
//    for results 1, 2, 3, 4 and 20.
// The downloads run one after another in the background (a small server must
// never run twenty downloads together), keep going after the caller hangs up,
// and the waiting list is kept in Yemot's storage so a restart continues it.
// Only the free direct download is used here: the paid engine always needs a
// key press for one video, so a batch never spends money.

// Digits typed one after another -> result numbers.
// '*' (or '#') may separate numbers: 1*5*15. Without a separator the typing is
// read as rising numbers (people type them in order), as many as possible,
// each between 1 and max: 123420 -> 1,2,3,4,20; 1520 -> 1,5,20; 1112 -> 11,12.
export function parseSelection(typed, max) {
  const raw = String(typed || '').replace(/[^0-9*#]/g, '');
  if (!raw || !(max > 0)) return [];
  if (/[*#]/.test(raw)) {
    const out = [];
    for (const part of raw.split(/[*#]+/).filter(Boolean)) {
      const sub = parseSelection(part, max);
      // a separated part is one number when it fits, otherwise split it too
      const n = Number(part);
      if (/^[1-9]\d*$/.test(part) && n <= max) out.push(n); else out.push(...sub);
    }
    return [...new Set(out)].sort((a, b) => a - b);
  }
  const w = String(max).length;
  // best[i][last] -> longest rising split of raw.slice(i) whose first number > last
  const memo = new Map();
  const best = (i, last) => {
    if (i === raw.length) return [];
    const key = i + ':' + last;
    if (memo.has(key)) return memo.get(key);
    let pick = null;
    for (let len = 1; len <= w && i + len <= raw.length; len++) {
      const part = raw.slice(i, i + len);
      if (part[0] === '0') break;
      const n = Number(part);
      if (n > max || n <= last) continue;
      const rest = best(i + len, n);
      if (rest && (!pick || rest.length + 1 > pick.length)) pick = [n, ...rest];
    }
    memo.set(key, pick);
    return pick;
  };
  const rising = best(0, 0);
  if (rising) return rising;
  // Not in rising order: one or two digits at a time, as they fit.
  const out = [];
  for (let i = 0; i < raw.length;) {
    let took = false;
    for (let len = Math.min(w, raw.length - i); len >= 1; len--) {
      const part = raw.slice(i, i + len), n = Number(part);
      if (part[0] !== '0' && n >= 1 && n <= max && (len === 1 || n > 9)) { out.push(n); i += len; took = true; break; }
    }
    if (!took) i++;
  }
  return [...new Set(out)].sort((a, b) => a - b);
}

// "1, 2, 3, 4 ו 20" for reading back.
export function spokenNumbers(list) {
  const a = (list || []).map(String);
  if (a.length <= 1) return a.join('');
  return a.slice(0, -1).join(', ') + ' ו ' + a[a.length - 1];
}

export const QUEUE_PATH = 'ivr2:/2/youtubejobs/batch-queue.json';

// One queue for the whole server. `start(item)` starts one download and
// returns its state object ({status:'running'|'ready'|'failed'}).
export function createBatchQueue({ store, start, log = console, pollMs = 3000, concurrency = 1 } = {}) {
  let items = [];       // waiting: { videoId, title, channelTitle, kind, subtitles, phone, at }
  let running = 0, loaded = false, saving = Promise.resolve();
  const save = () => { saving = saving.then(() => store?.write(QUEUE_PATH, { items }).catch(() => {})); return saving; };
  const keyOf = x => x.videoId + ':' + x.kind;

  async function load() {
    if (loaded) return; loaded = true;
    try { const d = await store?.read(QUEUE_PATH); if (Array.isArray(d?.items)) items = [...d.items.filter(x => x?.videoId), ...items.filter(x => !d.items.some(y => keyOf(y) === keyOf(x)))]; } catch {}
  }
  async function pump() {
    while (running < concurrency && items.length) {
      const item = items.shift(); running++;
      void save();
      (async () => {
        try {
          const state = await start(item);
          if (state && state.status === 'running') {
            while (state.status === 'running') await new Promise(r => setTimeout(r, pollMs));
          }
          log.info?.('[BATCH] download finished', { videoId: item.videoId, kind: item.kind, status: state?.status || 'skipped', left: items.length });
        } catch (e) {
          log.warn?.('[BATCH] download failed', { videoId: item.videoId, kind: item.kind, message: String(e?.message || e).slice(0, 160) });
        } finally { running--; void pump(); }
      })();
    }
  }
  return {
    // Adds videos (already waiting ones are not added twice) and starts.
    async add(videos, { kind, subtitles = false, phone = '' } = {}) {
      await load();
      const have = new Set(items.map(keyOf));
      let added = 0;
      for (const v of videos || []) {
        const it = { videoId: String(v.videoId), title: String(v.title || ''), channelTitle: String(v.channelTitle || ''), durationSeconds: v.durationSeconds ?? null, kind, subtitles: !!subtitles, phone: String(phone || ''), at: new Date().toISOString() };
        if (!/^[A-Za-z0-9_-]{11}$/.test(it.videoId) || have.has(keyOf(it))) continue;
        have.add(keyOf(it)); items.push(it); added++;
      }
      await save();
      const waiting = items.length;
      void pump();
      return { added, waiting, running };
    },
    // After a restart: continue what was waiting.
    async resume() { await load(); const n = items.length; if (n) log.info?.('[BATCH] resuming waiting downloads', { waiting: n }); void pump(); return n; },
    get size() { return items.length + running; },
    _items: () => items,
  };
}
