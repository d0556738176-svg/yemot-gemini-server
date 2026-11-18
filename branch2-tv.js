// Extension 2, key 8: six live TV channels as phone audio (owner, 18.11).
//
// The audio comes from OUR server, not from a Yemot "internet broadcast":
// live-relay.js listens to the channel's own public live stream, turns it into
// phone pieces in the owner's quality (WAV PCM, mono, 16 kHz, 16-bit, peaks at
// -2 dB, speech cleaned below ~90 Hz) and the call plays them one after
// another, about a minute behind live. One relay per channel, shared by every
// caller on it.
//
// Sources: only each broadcaster's own public live stream (its site or its
// official YouTube live). Nothing behind DRM, sign-in or a paid entitlement is
// opened: if a source needs that, yt-dlp/ffmpeg simply cannot read it and the
// channel says it is unavailable.
//
// The owner can replace a channel's source without code: the Yemot text file
// ivr2:/2/8/channels.txt, lines "1=https://..." (one or more, tried in order).

export const TV_CHANNELS = Object.freeze([
  { key: '1', title: 'כאן 11', pages: ['https://www.kan.org.il/live/'], yt: 'כאן 11 שידור חי', owner: /כאן|kan/i },
  { key: '2', title: 'ערוץ 12', pages: [], yt: 'חדשות 12 שידור חי', owner: /N12|חדשות 12|keshet|קשת|mako/i },
  { key: '3', title: 'ערוץ 13', pages: [], yt: 'חדשות 13 שידור חי', owner: /13|רשת/i },
  { key: '4', title: 'ערוץ 14', pages: [], yt: 'ערוץ 14 שידור חי', owner: /14/i },
  { key: '5', title: 'איי 24 ניוז', pages: ['https://www.i24news.tv/he/live'], yt: 'i24NEWS עברית שידור חי', owner: /i24/i },
  { key: '6', title: 'ערוץ הכנסת', pages: [], yt: 'ערוץ הכנסת שידור חי', owner: /כנסת|knesset/i },
]);

// Speech-friendly phone sound (owner's spec for shiurim/lessons, 18.11): cut
// the low rumble, gentle noise reduction, loudness with true peak -2 dB.
export const TV_AUDIO_FILTER = 'highpass=f=90,afftdn=nf=-25,loudnorm=I=-16:TP=-2';

export function parseOverrides(text) {
  const out = {};
  for (const raw of String(text || '').split(/[\r\n;]+/)) {
    const m = raw.trim().match(/^([1-6])\s*=\s*(https?:\/\/\S+)$/i);
    if (!m) continue;
    try { const u = new URL(m[2]); if (!/^https?:$/.test(u.protocol)) continue; } catch { continue; }
    (out[m[1]] ||= []).push(m[2]);
  }
  return out;
}

// Ordered list of page addresses to try for one channel.
export function candidatesFor(ch, overrides = {}) {
  return [...(overrides[ch.key] || []), ...ch.pages];
}

// Picks the channel's own broadcast among YouTube "live now" results.
export function pickOfficialLive(ch, list) {
  return (list || []).find(e => e?.url && ch.owner.test(String(e.uploader || '')) ) || null;
}

const CACHE_MS = 20 * 60 * 1000;
const cache = new Map(); // key -> { page, at, how }
const lastCheck = new Map(); // key -> { ok, page, how, at, reason }

// Finds a page/stream address that really plays now for a channel.
// deps: { resolveStream(url,{impersonate}), youtubeLiveNow(q), overrides }
export async function findChannelSource(ch, deps, { fresh = false } = {}) {
  const hit = cache.get(ch.key);
  if (!fresh && hit && Date.now() - hit.at < CACHE_MS) return hit;
  const tried = [];
  for (const page of candidatesFor(ch, deps.overrides || {})) {
    const src = await deps.resolveStream(page, { impersonate: true }).catch(() => null);
    tried.push(page);
    if (src) { const r = { page, at: Date.now(), how: 'site', impersonate: true }; cache.set(ch.key, r); return r; }
  }
  const live = await deps.youtubeLiveNow(ch.yt).catch(() => []);
  const yt = pickOfficialLive(ch, live);
  if (yt) {
    const src = await deps.resolveStream(yt.url, {}).catch(() => null);
    if (src) { const r = { page: yt.url, at: Date.now(), how: 'youtube', uploader: yt.uploader || null, impersonate: false }; cache.set(ch.key, r); return r; }
    tried.push(yt.url);
  }
  cache.delete(ch.key);
  return { page: null, tried, liveFound: (live || []).length };
}

export function forget(key) { cache.delete(key); }

// Read-only status for /tv-status (no keys, nothing secret).
export function tvStatus(relays) {
  return TV_CHANNELS.map(ch => {
    const c = cache.get(ch.key), chk = lastCheck.get(ch.key);
    const relay = c?.page ? [...(relays?.values?.() || [])].find(r => r.url === c.page && !r.stopped) : null;
    return { key: ch.key, title: ch.title, source: c?.page || null, how: c?.how || null, uploader: c?.uploader || null,
      lastCheck: chk || null, relay: relay ? { pieces: relay.next, listeningSince: new Date(relay.startedAt).toISOString(), error: relay.error } : null };
  });
}

// Checks all six now (no calls, no Yemot changes): which source each would use.
let checking = null, checkedAt = 0;
export async function checkAllChannels(deps) {
  if (checking) return checking;
  if (Date.now() - checkedAt < 120000) return [...lastCheck.values()];
  checking = (async () => {
    const out = [];
    for (const ch of TV_CHANNELS) {
      const r = await findChannelSource(ch, deps, { fresh: true }).catch(e => ({ page: null, reason: String(e?.message || e).slice(0, 100) }));
      const row = { key: ch.key, title: ch.title, ok: !!r.page, page: r.page || null, how: r.how || null, uploader: r.uploader || null, tried: r.tried || undefined, liveFound: r.liveFound, at: new Date().toISOString() };
      lastCheck.set(ch.key, row); out.push(row);
    }
    checkedAt = Date.now();
    return out;
  })().finally(() => { checking = null; });
  return checking;
}

export const menuText = (prefix = '') => prefix + 'ברוכים הבאים לשידורים החיים. ' +
  TV_CHANNELS.map(c => 'ל' + c.title + ' הקישו ' + c.key).join(', ') + '. לחזרה הקישו כוכבית.';
