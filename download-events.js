// What happened to each download, kept across restarts (owner, 19.11: "the
// file did not reach אודיו and the video did not download" — the reason
// must be readable afterwards). The last 200 events, in Yemot storage;
// shown in /branch2-diag -> downloadEvents. No tokens, no caller numbers.
const PATH = 'ivr2:/2/youtubejobs/download_events.json';
let events = null, store = null, timer = null, loading = null;

export function attachStore(s) { store = s; }
async function load() {
  if (events) return events;
  if (!loading) loading = (async () => { const old = store ? await store.read(PATH).catch(() => null) : null; events = Array.isArray(old?.events) ? old.events : []; return events; })();
  return loading;
}
export async function downloadEvent(kind, id, fields = {}) {
  try {
    const list = await load();
    const clean = Object.fromEntries(Object.entries(fields).map(([k, v]) => [k, typeof v === 'string' ? v.replace(/token=[^&\s]+/g, 'token=[x]').slice(0, 240) : v]));
    list.push({ at: new Date().toISOString(), kind, id: String(id || ''), ...clean });
    if (list.length > 200) list.splice(0, list.length - 200);
    clearTimeout(timer);
    timer = setTimeout(() => { store?.write(PATH, { events: list }).catch(() => {}); }, 3000);
    timer.unref?.();
  } catch { /* never breaks a download */ }
}
export async function recentDownloadEvents(n = 60) { return (await load().catch(() => [])).slice(-n); }
