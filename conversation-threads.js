// Conversation history for extensions 1 and 3 (owner, 19.11).
//
// Each extension keeps its own conversations per caller, with no limit:
//  * a conversation goes on across calls ("continuous memory in a series")
//    until he asks for a new one ("שיחה חדשה");
//  * key 3 at the start of the call (or saying "היסטוריה") lists the earlier
//    conversations, newest first, and he can go back to any of them.
// Stored on the server's own disk (one small JSON file per caller and
// extension), written atomically, so nothing depends on a slow outside store.
import { mkdir, readFile, writeFile, rename } from 'node:fs/promises';
import { join } from 'node:path';

const DIR = () => process.env.CONVERSATION_DIR || '/var/lib/yemot-data/conversations';
const cache = new Map();
const locks = new Map();
const safe = s => String(s || '').replace(/[^0-9a-zA-Z_-]/g, '').slice(0, 40) || 'x';
const fileOf = (branch, phone) => join(DIR(), safe(branch), safe(phone) + '.json');
const newId = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 6);

// One write at a time per file, in order.
function serial(key, fn) {
  const prev = locks.get(key) || Promise.resolve();
  const next = prev.then(fn, fn);
  locks.set(key, next.catch(() => {}));
  return next;
}
async function load(branch, phone) {
  const k = branch + '|' + phone;
  if (cache.has(k)) return cache.get(k);
  let st = null;
  try { st = JSON.parse(await readFile(fileOf(branch, phone), 'utf8')); } catch {}
  if (!st || !Array.isArray(st.threads)) st = { current: '', threads: [] };
  cache.set(k, st);
  return st;
}
async function save(branch, phone, st) {
  const f = fileOf(branch, phone);
  await mkdir(join(DIR(), safe(branch)), { recursive: true });
  const tmp = f + '.' + process.pid + '.tmp';
  await writeFile(tmp, JSON.stringify(st), 'utf8');
  await rename(tmp, f);
}
// A short name for the conversation: his first real question.
export function titleOf(text) {
  const t = String(text || '').replace(/^בחרתי באפשרות\s*\d+\s*:?\s*/u, '').replace(/[״"]/g, '').replace(/\s+/g, ' ').trim();
  const words = t.split(' ');
  return words.length > 9 ? words.slice(0, 9).join(' ') + '...' : t;
}
const usable = k => k && k !== 'לא מזוהה';

// The conversation in progress (made on first use; earlier saved turns of the
// caller, from before conversations existed, become his first conversation).
export async function currentThread(branch, phone, { legacy = [] } = {}) {
  if (!usable(phone)) return null;
  return serial(branch + '|' + phone, async () => {
    const st = await load(branch, phone);
    let th = st.threads.find(t => t.id === st.current);
    if (!th) {
      const turns = (legacy || []).filter(e => e && e.user).map(e => ({ time: e.time, callId: String(e.callId || ''), user: String(e.user), gemini: String(e.gemini || ''), ...(e.ref ? { ref: e.ref } : {}) }));
      th = { id: newId(), title: turns.length ? 'השיחות הקודמות' : '', started: turns[0]?.time || new Date().toISOString(), updated: turns.at(-1)?.time || new Date().toISOString(), turns };
      st.threads.push(th); st.current = th.id;
      await save(branch, phone, st);
    }
    return th;
  });
}
export async function appendTurn(branch, phone, entry) {
  if (!usable(phone) || !entry?.user) return false;
  return serial(branch + '|' + phone, async () => {
    const st = await load(branch, phone);
    let th = st.threads.find(t => t.id === st.current);
    if (!th) { th = { id: newId(), title: '', started: new Date().toISOString(), updated: '', turns: [] }; st.threads.push(th); st.current = th.id; }
    th.turns.push({ time: entry.time || new Date().toISOString(), callId: String(entry.callId || ''), user: String(entry.user), gemini: String(entry.gemini || ''), ...(entry.ref ? { ref: entry.ref } : {}) });
    th.updated = new Date().toISOString();
    if (!th.title && !/^(?:בחרתי באפשרות|כן|לא|אוקיי|שלום|היי)/u.test(entry.user)) th.title = titleOf(entry.user);
    await save(branch, phone, st);
    return true;
  });
}
export async function newThread(branch, phone) {
  if (!usable(phone)) return null;
  return serial(branch + '|' + phone, async () => {
    const st = await load(branch, phone);
    // An empty conversation is reused, not piled up.
    let th = st.threads.find(t => t.id === st.current);
    if (!th || th.turns.length) { th = { id: newId(), title: '', started: new Date().toISOString(), updated: new Date().toISOString(), turns: [] }; st.threads.push(th); }
    st.current = th.id;
    await save(branch, phone, st);
    return th;
  });
}
export async function selectThread(branch, phone, id) {
  if (!usable(phone)) return null;
  return serial(branch + '|' + phone, async () => {
    const st = await load(branch, phone);
    const th = st.threads.find(t => t.id === id);
    if (!th) return null;
    st.current = th.id; th.updated = new Date().toISOString();
    await save(branch, phone, st);
    return th;
  });
}
// Earlier conversations with something in them, newest first.
export async function listThreads(branch, phone) {
  if (!usable(phone)) return [];
  const st = await load(branch, phone);
  return st.threads.filter(t => t.turns.length).sort((a, b) => Date.parse(b.updated || 0) - Date.parse(a.updated || 0))
    .map(t => ({ id: t.id, title: t.title || titleOf(t.turns[0]?.user), updated: t.updated, turns: t.turns.length, current: t.id === st.current }));
}
// What the brain hears of the conversation: its turns from earlier calls (the
// current call's turns come separately), and older topics in a line.
export function threadContext(th, callId, { keep = 16 } = {}) {
  if (!th) return { prior: [], topics: '' };
  const earlier = th.turns.filter(t => String(t.callId) !== String(callId || ''));
  const prior = earlier.slice(-keep);
  const older = earlier.slice(0, -keep).map(t => titleOf(t.user)).filter(Boolean);
  const topics = older.length ? 'נושאים מוקדמים יותר באותה שיחה: ' + [...new Set(older)].slice(-25).join('; ') : '';
  return { prior, topics };
}
export function spokenWhen(iso, now = new Date()) {
  const d = new Date(iso), day = 86400000;
  const f = x => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Jerusalem' }).format(x);
  if (f(d) === f(now)) return 'מהיום';
  if (f(d) === f(new Date(now - day))) return 'מאתמול';
  const days = Math.round((now - d) / day);
  if (days < 7) return 'מלפני ' + days + ' ימים';
  const he = new Intl.DateTimeFormat('he-IL', { timeZone: 'Asia/Jerusalem', day: 'numeric', month: 'long' }).format(d);
  return 'מה-' + he;
}
export function clearThreadCache() { cache.clear(); }
