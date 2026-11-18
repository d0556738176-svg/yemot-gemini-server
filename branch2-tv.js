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
  { key: '1', title: 'כאן 11', pages: ['https://www.kan.org.il/live/', 'https://kancdn.medonecdn.net/livehls/oil/kancdn-live/live/kan11/live.livx/playlist.m3u8'], yt: 'כאן 11 שידור חי', owner: /^כאן\b|כאן 11|kan ?11|כאן \| חדשות|kan news/i, alt: ['כאן חדשות שידור חי'] },
  { key: '2', title: 'ערוץ 12', pages: ['https://www.mako.co.il/mako-vod-live-tv/VOD-6540b8dcb64fd31006.htm'], yt: 'חדשות 12 שידור חי', owner: /\bN12\b|חדשות 12|קשת 12|keshet ?12|mako/i, alt: ['N12 live'] },
  { key: '3', title: 'ערוץ 13', pages: ['https://13tv.co.il/allshows/2010263/'], yt: 'חדשות 13 שידור חי', owner: /חדשות 13|רשת 13|reshet ?13|13 ?tv|ערוץ 13|כאן 13/i, alt: ['רשת 13 שידור חי'] },
  { key: '4', title: 'ערוץ 14', pages: ['https://www.c14.co.il/live', 'https://r.il.cdn-redge.media/livehls/oil/ch14/live/ch14/live.livx/playlist.m3u8'], yt: 'ערוץ 14 שידור חי', owner: /\bC14\b|ערוץ 14|עכשיו 14|now ?14/i },
  { key: '5', title: 'איי 24 ניוז', pages: ['https://www.i24news.co.il/live', 'https://www.i24news.tv/he/live', 'https://i24newshebrew-cdn.encoders.immergo.tv/master.m3u8'], yt: 'i24NEWS עברית שידור חי', owner: /i24/i },
  { key: '6', title: 'ערוץ הכנסת', pages: ['https://www.knesset.tv/live/', 'https://contact.gostreaming.tv/Knesset/myStream/playlist.m3u8'], yt: 'ערוץ הכנסת שידור חי', owner: /כנסת|knesset/i, alt: ['ערוץ כנסת שידור חי', 'Knesset live'] },
  { key: '7', title: 'רדיו איי 24 ניוז', pages: ['https://www.i24news.co.il/live-radio'] },
  { key: '8', title: 'רדיו ערוץ 14', pages: ['https://www.c14.co.il/radio'] },
]);

// Speech-friendly phone sound (owner's spec for shiurim/lessons, 18.11): cut
// the low rumble, gentle noise reduction, loudness with true peak -2 dB.
export const TV_AUDIO_FILTER = 'highpass=f=90,afftdn=nf=-25,loudnorm=I=-16:TP=-2';

export function parseOverrides(text) {
  const out = {};
  for (const raw of String(text || '').split(/[\r\n;]+/)) {
    const m = raw.trim().match(/^([1-8])\s*=\s*(https?:\/\/\S+)$/i);
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
    if (src) { const r = { page, at: Date.now(), how: 'site', impersonate: true }; cache.set(ch.key, r); return r; }
    // Deeper: the page's own HTML, for the player's stream inside it.
    if (deps.inspect) {
      let why = null;
      const it = await deps.inspect({ url: page, title: ch.title }, { timeoutMs: 40000, onFailure: f => { why = f?.reason || null; } }).catch(() => null);
      if (it?.url && it.hasAudio && (it.live || !it.durationSec)) {
        const r = { page: it.url, from: page, at: Date.now(), how: 'page', impersonate: !!it.impersonate, referer: it.referer || page };
        cache.set(ch.key, r); return r;
      }
      if (it?.youtube) {
        const ysrc = await deps.resolveStream(it.youtube, {}).catch(() => null);
        if (ysrc) { const r = { page: it.youtube, from: page, at: Date.now(), how: 'page-youtube', impersonate: false }; cache.set(ch.key, r); return r; }
      }
      tried.push(page + (why ? ' (' + why + ')' : it ? ' (not live audio)' : ' (no player found)'));
    } else tried.push(page);
  }
  if (!ch.yt) { cache.delete(ch.key); return { page: null, tried }; }
  // YouTube "live now": the main search, then the channel's other names.
  let live = [], yt = null; const seen = [];
  for (const q of [ch.yt, ...(ch.alt || [])]) {
    const found = await deps.youtubeLiveNow(q).catch(() => []);
    live = live.concat(found);
    for (const e of found) if (e?.uploader && !seen.includes(e.uploader)) seen.push(e.uploader);
    yt = pickOfficialLive(ch, found);
    if (yt) break;
  }
  if (yt) {
    const src = await deps.resolveStream(yt.url, {}).catch(() => null);
    if (src) { const r = { page: yt.url, at: Date.now(), how: 'youtube', uploader: yt.uploader || null, impersonate: false }; cache.set(ch.key, r); return r; }
    tried.push(yt.url);
  }
  cache.delete(ch.key);
  return { page: null, tried, liveFound: live.length, seen: seen.slice(0, 20) };
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
      const row = { key: ch.key, title: ch.title, ok: !!r.page, page: r.page || null, from: r.from || undefined, how: r.how || null, uploader: r.uploader || null, tried: r.tried || undefined, liveFound: r.liveFound, seen: r.seen || undefined, at: new Date().toISOString() };
      lastCheck.set(ch.key, row); out.push(row);
    }
    checkedAt = Date.now();
    return out;
  })().finally(() => { checking = null; });
  return checking;
}

export const menuText = (prefix = '') => prefix + 'ברוכים הבאים לשידורים החיים. ' +
  TV_CHANNELS.map(c => 'ל' + c.title + ' הקישו ' + c.key).join(', ') + '. לחזרה הקישו כוכבית.';
