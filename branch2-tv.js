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

// Owner, 21.11: main-menu extension 10 = live radio, the same phone sound as
// extension 5, live only (no replays), in the owner's order. The key 'rN' is
// the station's own (cache/status), 'digit' is what the caller presses.
export const RADIO_CHANNELS = Object.freeze([
  { key: 'r1', digit: '1', title: 'קול חי', rm: { slug: 'kol-chai', name: 'קול חי' }, pages: ['https://www.93fm.co.il/'] },
  { key: 'r2', digit: '2', title: 'קול פליי', rm: { slug: 'kol-play', name: 'קול פליי' }, pages: [] },
  { key: 'r3', digit: '3', title: 'קול חי מיוזיק', rm: { slug: 'kol-chai-music', name: 'קול חי מיוזיק' }, pages: [] },
  { key: 'r4', digit: '4', title: 'קול ברמה', rm: { slug: 'kol-barama', name: 'קול ברמה' }, pages: ['https://kol-barama.co.il/live/'] },
  { key: 'r5', digit: '5', title: 'כאן ב', rm: { slug: 'kan-bet', name: 'כאן ב' }, pages: [] },
  { key: 'r6', digit: '6', title: '103 אף אם', rm: { slug: '103fm', name: '103' }, pages: ['https://103fm.maariv.co.il/include/OnLineView.aspx'] },
  { key: 'r7', digit: '7', title: 'גלי ישראל', rm: { slug: 'galei-israel', name: 'גלי ישראל' }, pages: [] },
  { key: 'r8', digit: '8', title: 'גלי צהל', rm: { slug: 'galei-tzahal', name: 'גלי צהל' }, pages: ['https://glzwizzlv.bynetcdn.com/glz_mp3'] },
]);

// radiomood.co.il plays every station through its own relay,
// /api/radio-stream?stationId=stationNNN. Its station pages start the site's
// default station (station001) in the player, so the page's player must not
// be used: the station number is taken from the site's own list by the
// station's name (21.11: all stations had come out as station001).
export const rmNorm = t => String(t || '').replace(/\([^)]*\)/g, '').replace(/רדיו|fm|אף אם|["'׳״`\s.\-]/gi, '').toLowerCase();
export function rmStations(html) {
  const flat = String(html || '').replace(/\\+/g, '');
  const out = new Map();
  for (const m of flat.matchAll(/"id":"(station\d+)","name":"(.*?)","imagePath"/g)) if (!out.has(m[1])) out.set(m[1], m[2]);
  return [...out].map(([id, name]) => ({ id, name }));
}
export function rmPick(list, name) {
  const want = rmNorm(name);
  return list.find(s => rmNorm(s.name) === want) || null;
}
const rmCache = { at: 0, list: [] };
async function rmStreamFor(ch, deps) {
  if (!ch.rm) return null;
  if (Date.now() - rmCache.at > 6 * 3600 * 1000 || !rmCache.list.length) {
    const get = deps.fetchText || (async u => { const r = await fetch(u, { headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36' }, signal: AbortSignal.timeout(15000) }); return r.ok ? r.text() : ''; });
    const list = rmStations(await get('https://radiomood.co.il/stations/' + ch.rm.slug).catch(() => ''));
    if (list.length) Object.assign(rmCache, { at: Date.now(), list });
  }
  const st = rmPick(rmCache.list, ch.rm.name);
  if (!st) return null;
  return { id: st.id, name: st.name, urls: [0, 1].map(i => 'https://radiomood.co.il/api/radio-stream?stationId=' + st.id + '&sourceIndex=' + i) };
}

// Speech-friendly phone sound (owner's spec for shiurim/lessons, 18.11): cut
// the low rumble, gentle noise reduction, loudness with true peak -2 dB.
export const TV_AUDIO_FILTER = 'highpass=f=100,afftdn=nf=-25,loudnorm=I=-16:TP=-2';

export function parseOverrides(text) {
  const out = {};
  for (const raw of String(text || '').split(/[\r\n;]+/)) {
    const m = raw.trim().match(/^(r?[1-8])\s*=\s*(https?:\/\/\S+)$/i);
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
  // The owner's own address (channels.txt) first, then the station's own
  // relay on radiomood by its number, then the station's own pages.
  const own = (deps.overrides || {})[ch.key] || [];
  const rmFirst = async () => {
    const rm = await rmStreamFor(ch, deps).catch(() => null);
    if (!rm) { if (ch.rm) tried.push('radiomood: ' + ch.rm.name + ' not in the site list'); return null; }
    for (const u of rm.urls) {
      const ok = await deps.resolveStream(u, {}).catch(() => null);
      if (ok) { const r = { page: u, at: Date.now(), how: 'radiomood', station: rm.id + ' ' + rm.name, impersonate: false, referer: 'https://radiomood.co.il/stations/' + ch.rm.slug }; cache.set(ch.key, r); return r; }
    }
    tried.push('radiomood ' + rm.id + ' (no sound)');
    return null;
  };
  if (ch.rm && !own.length) { const r = await rmFirst(); if (r) return r; }
  for (const page of candidatesFor(ch, deps.overrides || {})) {
    const src = await deps.resolveStream(page, { impersonate: true }).catch(() => null);
    if (src) { const r = { page, at: Date.now(), how: 'site', impersonate: true }; cache.set(ch.key, r); return r; }
    // Deeper: the page's own HTML, for the player's stream inside it.
    if (deps.inspect) {
      let why = null;
      const it = await deps.inspect({ url: page, title: ch.title }, { timeoutMs: 40000, onFailure: f => { why = f?.reason || null; } }).catch(() => null);
      if (it?.url && /radiomood\.co\.il\/api\/radio-stream/.test(it.url)) { tried.push(page + ' (site default player, not used)'); continue; }
      if (it?.url && it.hasAudio && (it.live || !it.durationSec)) {
        // A site's own relay link that carries the station's address (e.g.
        // radiomood.co.il/api/radio-stream?url=...): the station's own stream
        // first, the relay only if that does not play.
        const direct = unwrapRelay(it.url);
        if (direct) {
          const ok = await deps.resolveStream(direct, {}).catch(() => null);
          if (ok) { const r = { page: direct, from: page, via: it.url, at: Date.now(), how: 'page-direct', impersonate: false, referer: page }; cache.set(ch.key, r); return r; }
        }
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
  if (ch.rm && own.length) { const r = await rmFirst(); if (r) return r; }
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

// The stream address inside a relay link's query, if there is one.
export function unwrapRelay(u) {
  try {
    const url = new URL(u);
    for (const [, v] of url.searchParams) {
      const d = String(v || '').trim();
      if (/^https?:\/\/[^\s]+$/i.test(d)) { const inner = new URL(d); if (inner.host !== url.host) return inner.href; }
    }
  } catch {}
  return null;
}

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

// The radio stations (extension 10) checked the same way, for the status page.
export const radioCheck = { status: 'idle', at: null, stations: [] };
export function startRadioCheck(deps) {
  if (radioCheck.status === 'running') return radioCheck;
  Object.assign(radioCheck, { status: 'running', at: new Date().toISOString(), stations: [] });
  checkRadio(deps, row => radioCheck.stations.push(row)).catch(() => {}).finally(() => { radioCheck.status = 'done'; radioCheck.finishedAt = new Date().toISOString(); });
  return radioCheck;
}
export async function checkRadio(deps, onRow = () => {}) {
  const out = [];
  for (const ch of RADIO_CHANNELS) {
    const r = await findChannelSource(ch, deps, { fresh: true }).catch(e => ({ page: null, reason: String(e?.message || e).slice(0, 100) }));
    let sound;
    if (r.page && deps.probe) { const pr = await deps.probe(r.page, { referer: r.referer || null }).catch(e => ({ ok: false, reason: String(e?.message || e).slice(0, 80) })); sound = { ok: !!pr?.ok, sec: pr?.audioSec ?? null }; }
    const row = { key: ch.key, digit: ch.digit, title: ch.title, ok: !!r.page && (!sound || sound.ok), sound, page: r.page || null, station: r.station || undefined, via: r.via || undefined, from: r.from || undefined, how: r.how || null, tried: r.tried || undefined, at: new Date().toISOString() };
    lastCheck.set(ch.key, row); out.push(row); onRow(row);
  }
  return out;
}

export const menuText = (prefix = '') => prefix + 'ברוכים הבאים לשידורים החיים. ' +
  TV_CHANNELS.map(c => 'ל' + c.title + ' הקישו ' + c.key).join(', ') + '. לחזרה הקישו כוכבית.';
