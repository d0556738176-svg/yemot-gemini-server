// Extension 5: live internet broadcast channels, switched on only when the owner asks.
//
// Yemot plays a live internet stream through its own "שידור חי אינטרנטי" service: each
// stream defined there has a name, and music_on_hold=<name> plays it. Listening time is
// limited, so the channels are OFF by default and open only after the owner turns them on
// from the phone (hidden key 0 + PIN), for a number of hours he picks (auto-off).
//
// Channels:   ivr2:/5/live-channels.txt (editable in the Yemot site), one per line:
//               1=<stream name in Yemot>=<spoken title>
//             or the env var BRANCH5_LIVE_CHANNELS: "1=name=title;2=name=title".
// State:      ivr2:/5/live-state.txt (JSON) so a restart or sleep never forgets on/off.
// Admin PIN:  BRANCH5_ADMIN_PIN (digits). Callers listed in BRANCH5_ADMIN_PHONES skip the PIN.

const API = 'https://www.call2all.co.il/ym/api';
const FOLDER = 'ivr2:/5';
const STATE_FILE = FOLDER + '/live-state.txt';
const CHANNELS_FILE = FOLDER + '/live-channels.txt';
const log = (...a) => console.info('[LIVE5]', ...a);

function token() {
  const t = String(process.env.YEMOT_TOKEN || '').trim();
  if (t) return t;
  const u = String(process.env.YEMOT_API_USERNAME || '').trim(), p = String(process.env.YEMOT_API_PASSWORD || '').trim();
  return u && p ? u + ':' + p : '';
}

async function getText(what) {
  if (!token()) return null;
  try {
    const r = await fetch(API + '/GetTextFile?' + new URLSearchParams({ token: token(), what }), { signal: AbortSignal.timeout(8000) });
    const j = await r.json().catch(() => null);
    return j?.responseStatus === 'OK' ? String(j.contents ?? '') : null;
  } catch { return null; }
}

async function putText(what, contents) {
  const r = await fetch(API + '/UploadTextFile', { method: 'POST', body: new URLSearchParams({ token: token(), what, contents }), signal: AbortSignal.timeout(10000) });
  const j = await r.json().catch(() => null);
  if (j?.responseStatus !== 'OK') throw new Error('UploadTextFile ' + what + ': ' + (j?.message || r.status));
}

// "1=StreamName=Title" lines or ";"-separated. Keys 1..9 only (0 is the owner's key).
export function parseChannels(text) {
  const out = [];
  for (const raw of String(text || '').split(/[\n;]+/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const [key, name, ...rest] = line.split('=').map(s => s.trim());
    if (!/^[1-9]$/.test(key || '') || !name) continue;
    if (out.some(c => c.key === key)) continue;
    out.push({ key, name, title: rest.join('=').trim() || ('ערוץ ' + key) });
  }
  return out.sort((a, b) => Number(a.key) - Number(b.key));
}

export function isOn(state, now = Date.now()) {
  if (!state?.on) return false;
  return !state.until || now < Number(state.until);
}

export function remainingSeconds(state, now = Date.now(), perListenCap = 3 * 3600) {
  if (!isOn(state, now)) return 0;
  const left = state.until ? Math.floor((Number(state.until) - now) / 1000) : perListenCap;
  return Math.max(0, Math.min(left, perListenCap));
}

let stateCache = null, stateAt = 0;
async function loadState() {
  if (stateCache && Date.now() - stateAt < 15000) return stateCache;
  const txt = await getText(STATE_FILE);
  let s = { on: false };
  try { if (txt) s = JSON.parse(txt); } catch {}
  stateCache = s; stateAt = Date.now();
  return s;
}
async function saveState(s) {
  stateCache = s; stateAt = Date.now();
  await putText(STATE_FILE, JSON.stringify(s));
}

let chanCache = null, chanAt = 0;
async function loadChannels() {
  if (chanCache && Date.now() - chanAt < 60000) return chanCache;
  const fromFile = parseChannels(await getText(CHANNELS_FILE));
  chanCache = fromFile.length ? fromFile : parseChannels(process.env.BRANCH5_LIVE_CHANNELS || '');
  chanAt = Date.now();
  return chanCache;
}

// Yemot TTS rejects punctuation (. , - = & etc.), so keep only letters, digits and spaces.
const say = t => [{ type: 'text', data: String(t).replace(/[^\p{L}\p{N}\s]/gu, ' ').replace(/\s+/g, ' ').trim() }];
const isStar = v => /\*/.test(String(v || ''));
const hoursWords = h => (h === 1 ? 'שעה אחת' : h === 2 ? 'שעתיים' : h + ' שעות');

function isAdminPhone(phone) {
  const list = String(process.env.BRANCH5_ADMIN_PHONES || '').split(/[,;\s]+/).map(p => p.replace(/\D/g, '')).filter(Boolean);
  const p = String(phone || '').replace(/\D/g, '');
  return !!p && list.some(x => x === p || x.endsWith(p) || p.endsWith(x));
}

async function adminMenu(call) {
  const pin = String(process.env.BRANCH5_ADMIN_PIN || '').replace(/\D/g, '');
  if (!isAdminPhone(call.phone)) {
    if (!pin) return call.id_list_message(say('ניהול השידור עדיין לא הוגדר'), { prependToNextAction: true });
    const typed = await call.read(say('הקישו את קוד הניהול ובסיומו סולמית'), 'tap', { max_digits: 12, min_digits: 1, sec_wait: 10, typing_playback_mode: 'No' });
    if (String(typed).replace(/\D/g, '') !== pin) {
      log('wrong admin PIN', { phone: String(call.phone || '').slice(-4) });
      return call.id_list_message(say('הקוד שגוי'), { prependToNextAction: true });
    }
  }
  for (;;) {
    const s = await loadState(); stateAt = 0; // fresh read for the owner
    const now = isOn(s);
    let status = now ? 'השידור החי פעיל כעת' : 'השידור החי כבוי כעת';
    if (now && s.until) status += ', ייכבה אוטומטית בעוד ' + Math.max(1, Math.round((s.until - Date.now()) / 60000)) + ' דקות';
    const k = await call.read(say(status + '. להפעלה הקישו 1, לכיבוי הקישו 2, לחזרה לערוצים הקישו 3'), 'tap', { max_digits: 1, min_digits: 1, sec_wait: 10, digits_allowed: [1, 2, 3] });
    if (isStar(k)) return call.go_to_folder('/');
    if (k === '3') return;
    if (k === '2') {
      await saveState({ on: false, changedAt: Date.now() });
      log('turned OFF by owner');
      await call.read(say('השידור החי כובה. לחזרה הקישו 1'), 'tap', { max_digits: 1, min_digits: 1, sec_wait: 5, allow_empty: true, empty_val: '1' });
      continue;
    }
    if (k === '1') {
      const def = Math.max(0, Math.min(9, Number(process.env.BRANCH5_DEFAULT_HOURS || 2) || 2));
      const h = await call.read(say('לכמה שעות להפעיל? הקישו מספר שעות בין 1 ל 9, או 0 עד שתכבו בעצמכם'), 'tap', { max_digits: 1, min_digits: 1, sec_wait: 10, digits_allowed: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9], allow_empty: true, empty_val: String(def) });
      const hours = Number(h) || 0;
      await saveState({ on: true, until: hours ? Date.now() + hours * 3600000 : 0, changedAt: Date.now() });
      log('turned ON by owner', { hours: hours || 'until off' });
      await call.read(say('השידור החי הופעל' + (hours ? ' ל' + hoursWords(hours) : ' עד שתכבו אותו') + '. לחזרה הקישו 1'), 'tap', { max_digits: 1, min_digits: 1, sec_wait: 5, allow_empty: true, empty_val: '1' });
    }
  }
}

export async function liveBroadcastHandler(call) {
  for (;;) {
    const [state, channels] = await Promise.all([loadState(), loadChannels()]);
    if (state.on && !isOn(state)) { // time is up: record it so the file shows the truth
      log('auto-off: time ended');
      saveState({ on: false, changedAt: Date.now(), reason: 'timer' }).catch(() => {});
    }
    if (!isOn(state) || !channels.length) {
      const msg = !channels.length ? 'עדיין לא חוברו ערוצי שידור' : 'השידור החי אינו פעיל כרגע';
      const k = await call.read(say(msg), 'tap', { max_digits: 1, min_digits: 1, sec_wait: 3, allow_empty: true, empty_val: 'x' });
      if (k === '0') { await adminMenu(call); continue; }
      return call.go_to_folder('/');
    }
    const menu = channels.map(c => 'ל' + c.title + ' הקישו ' + c.key).join(', ') + '. לתפריט הראשי הקישו כוכבית';
    const k = await call.read(say(menu), 'tap', { max_digits: 1, min_digits: 1, sec_wait: 8, digits_allowed: [0, ...channels.map(c => Number(c.key))], amount_attempts: 2 });
    if (isStar(k) || !k) return call.go_to_folder('/');
    if (k === '0') { await adminMenu(call); continue; }
    const ch = channels.find(c => c.key === k);
    if (!ch) continue;
    const secs = remainingSeconds(await loadState());
    if (!secs) continue;
    log('caller listening', { channel: ch.key, maxSec: secs });
    // Plays the stream until the switch-off time (or * by the caller); afterwards
    // Yemot calls back and the caller is back at this channel menu.
    return call.id_list_message([{ type: 'music_on_hold', data: { musicName: ch.name, maxSec: secs } }]);
  }
}

// Points extension 5 at this handler (production service only) and logs what it was before.
export async function configureLiveExtension(publicUrl) {
  if (process.env.BRANCH5_LIVE_AUTO_CONFIGURE === 'false' || /staging|test/i.test(process.env.RENDER_SERVICE_NAME || '')) return;
  if (!token() || !publicUrl) return;
  const want = 'type=api\napi_link=' + publicUrl.replace(/\/$/, '') + '/yemot-live\ntitle=שידור חי\n';
  const before = await getText(FOLDER + '/ext.ini');
  if (String(before || '').includes('/yemot-live')) { log('extension 5 already set'); }
  else {
    log('setting extension 5; previous ext.ini:', JSON.stringify(String(before || '').replace(/(password|token|api_key)[^\n]*/gi, '$1=…').slice(0, 400)));
    await putText(FOLDER + '/ext.ini', want);
  }
  // One-time look at where Yemot keeps account-level settings (names only), to find
  // whether internet-broadcast definitions live in a file the server can write.
  if (process.env.BRANCH5_LIVE_DISCOVER !== 'off') {
    try {
      for (const p of ['ivr2:/', 'ivr2:/MusicOnHold', 'ivr2:/music_on_hold']) {
        const r = await fetch(API + '/GetIVR2Dir?' + new URLSearchParams({ token: token(), path: p }), { signal: AbortSignal.timeout(10000) });
        const j = await r.json().catch(() => null);
        const names = [...(j?.dirs || []), ...(j?.files || []), ...(j?.ini || [])].map(x => x?.name || x?.what || '').filter(Boolean);
        log('dir', p, j?.responseStatus, JSON.stringify(names).slice(0, 900));
      }
    } catch (e) { log('dir listing failed', String(e?.message || e).slice(0, 120)); }
  }
  const channels = await loadChannels();
  const state = await loadState();
  log('ready', { channels: channels.map(c => c.key + ':' + c.name), on: isOn(state), pinSet: !!process.env.BRANCH5_ADMIN_PIN });
}
