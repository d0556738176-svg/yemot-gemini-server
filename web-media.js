// Whole-web search for extension 2 (keys 5/6) and extensions 1/3 (owner,
// 18.11). The main server searches the web (it holds the search keys); here
// every link found is opened with the downloader the way a browser would, and
// only links that really hold audio or video this server can download are
// kept, with their real title, site, length and picture. Sites that block
// automated readers (Cloudflare) are tried again posing as a real browser.
import { spawn } from 'node:child_process';
import { ytdlpPath } from './youtube-direct.js';
import { registerWebItem } from './web-items.js';
import { mediaRequestHeaders, mediaHeaderArgs } from './media-request-headers.js';
import { isMakoEpisode, resolveMakoPublic } from './mako-public-media.js';
import { sniffPage, browserAvailable } from './browser-media.js';
import { streamlinkResolve, streamlinkPath } from './streamlink-media.js';

const hostOf = u => { try { return new URL(u).hostname.replace(/^www\./, ''); } catch { return ''; } };
const YT = /(?:youtube\.com|youtu\.be)\//i;

export async function webCandidates(q, { env = process.env, fetchImpl = fetch, timeoutMs = 20000 } = {}) {
  const secret = String(env.WEB_HINTS_SECRET || '').trim();
  const base = String(env.WEB_HINTS_URL || 'https://yemot-gemini-server.onrender.com').replace(/\/+$/, '');
  if (!secret || !base) return [];
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const r = await fetchImpl(base + '/internal/web-videos', {
        method: 'POST', signal: AbortSignal.timeout(timeoutMs),
        headers: { 'content-type': 'application/json', 'x-web-hints-secret': secret }, body: JSON.stringify({ q })
      });
      if (r.ok) return (await r.json())?.items || [];
      if (![429, 502, 503, 504].includes(r.status)) return [];
    } catch { /* one retry */ }
    await new Promise(res => setTimeout(res, 800));
  }
  return [];
}

function probe(url, { bin = ytdlpPath(), impersonate = false, timeoutMs = 30000, referer = null, httpHeaders = null } = {}) {
  return new Promise(resolve => {
    const args = ['--no-warnings', '--ignore-config', '--no-cache-dir', '--dump-single-json', '--no-playlist', '--playlist-items', '1', '--socket-timeout', '10', '--retries', '0', '--extractor-retries', '0', ...(impersonate ? ['--impersonate', 'chrome'] : []), ...mediaHeaderArgs(httpHeaders), ...(referer ? ['--referer', referer] : []), '--', url];
    const p = spawn(bin, args, { stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, PATH: (process.env.PATH || '') + ':/usr/local/bin:/usr/bin' } });
    let out = '', err = '';
    const t = setTimeout(() => { p.kill('SIGKILL'); resolve({ ok: false, err: 'timeout' }); }, timeoutMs);
    p.stdout.on('data', d => { out += d; if (out.length > 20e6) p.kill('SIGKILL'); });
    p.stderr.on('data', d => { err = (err + d).slice(-1500); });
    p.on('error', e => { clearTimeout(t); resolve({ ok: false, err: e.message }); });
    p.on('close', code => {
      clearTimeout(t);
      if (code !== 0) return resolve({ ok: false, err: err.trim().split('\n').pop() || 'exit ' + code });
      try { resolve({ ok: true, info: JSON.parse(out) }); } catch { resolve({ ok: false, err: 'bad answer' }); }
    });
  });
}

// A page the downloader does not know: its own HTML is read for the media it
// plays (og:video/og:audio, <audio>/<video>/<source>, direct .mp3/.mp4/.m3u8
// links, a YouTube player inside it). Returns {media, title, image} or {youtube}.
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36';
export function mediaInHtml(html, pageUrl) {
  const abs = u => { try { return new URL(String(u).replace(/&amp;/g, '&').trim(), pageUrl).href; } catch { return null; } };
  const meta = name => (html.match(new RegExp('<meta[^>]+(?:property|name)=["\']' + name + '["\'][^>]+content=["\']([^"\']+)', 'i')) ||
    html.match(new RegExp('<meta[^>]+content=["\']([^"\']+)["\'][^>]+(?:property|name)=["\']' + name + '["\']', 'i')) || [])[1] || null;
  const title = (meta('og:title') || (html.match(/<title[^>]*>([^<]{2,200})<\/title>/i) || [])[1] || '').replace(/\s+/g, ' ').trim() || null;
  const image = meta('og:image') ? abs(meta('og:image')) : null;
  const found = [];
  // VideoObject is often nested in a TVEpisode or @graph. Parse JSON rather
  // than treating an embedded player URL as the media itself.
  const visit = value => {
    if (!value || typeof value !== 'object') return;
    if (Array.isArray(value)) { value.forEach(visit); return; }
    const types = [].concat(value['@type'] || []);
    if (types.some(t => /^(?:VideoObject|AudioObject)$/.test(t)) && typeof value.contentUrl === 'string') {
      found.push(abs(value.contentUrl));
    }
    for (const child of Object.values(value)) if (child && typeof child === 'object') visit(child);
  };
  for (const script of html.matchAll(/<script\b[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script\s*>/gi)) {
    try { visit(JSON.parse(script[1])); } catch { /* other metadata remains usable */ }
  }
  for (const n of ['og:video:secure_url', 'og:video:url', 'og:video', 'og:audio:secure_url', 'og:audio', 'twitter:player:stream']) { const v = meta(n); if (v) found.push(abs(v)); }
  for (const m of html.matchAll(/<(?:audio|video|source)[^>]+src=["']([^"']+)["']/gi)) found.push(abs(m[1]));
  for (const m of html.matchAll(/["'(=]((?:https?:)?\/\/[^"'()\s<>]+?\.(?:mp3|m4a|aac|ogg|opus|wav|flac|mp4|m4v|webm|m3u8|mpd|ism)(?:\?[^"'()\s<>]*)?)["')\s]/gi)) found.push(abs(m[1]));
  const media = [...new Set(found.filter(u => u && /^https?:/i.test(u) && !/\.(?:jpg|jpeg|png|gif|svg|webp)(?:\?|$)/i.test(u)))];
  if (media.length) return { media: media[0], mediaUrls: media.slice(0, 6), title, image };
  const yt = html.match(/(?:youtube(?:-nocookie)?\.com\/embed\/|youtube\.com\/watch\?v=|youtu\.be\/)([A-Za-z0-9_-]{11})/);
  if (yt) return { youtube: 'https://www.youtube.com/watch?v=' + yt[1], title };
  return null;
}
async function scanPage(url, { fetchImpl = fetch, timeoutMs = 12000 } = {}) {
  try {
    const r = await fetchImpl(url, { headers: { 'user-agent': UA, 'accept-language': 'he,en;q=0.8' }, redirect: 'follow', signal: AbortSignal.timeout(timeoutMs) });
    if (!r.ok || !/html/i.test(r.headers.get('content-type') || '')) return null;
    const html = (await r.text()).slice(0, 3e6);
    return mediaInHtml(html, r.url || url);
  } catch { return null; }
}

// Some HLS/DASH playlists omit CODECS, so yt-dlp cannot label their tracks.
// Ask ffprobe about the real stream instead of discarding it or guessing.
export function probeMediaStreams(url, { timeoutMs = 8000, headers = {}, cookie = null, bin = process.env.FFPROBE_PATH || 'ffprobe' } = {}) {
  return new Promise(resolve => {
    const context = Object.entries({ ...mediaRequestHeaders(headers), ...(cookie && !/[\r\n]/.test(cookie) ? { Cookie: cookie } : {}) }).map(([k, v]) => k + ': ' + v + '\r\n').join('');
    const p = spawn(bin, ['-v', 'error', '-analyzeduration', '2000000', '-probesize', '1000000', ...(context ? ['-headers', context] : []), '-show_entries', 'stream=codec_type:format=duration', '-of', 'json', url], { stdio: ['ignore', 'pipe', 'ignore'] });
    let out = '';
    const timer = setTimeout(() => { p.kill('SIGKILL'); resolve(null); }, Math.max(1, timeoutMs));
    p.stdout.on('data', d => { out += d; if (out.length > 100000) p.kill('SIGKILL'); });
    p.on('error', () => { clearTimeout(timer); resolve(null); });
    p.on('close', code => { clearTimeout(timer); try { resolve(code === 0 ? JSON.parse(out) : null); } catch { resolve(null); } });
  });
}

// The browser engine (browser-media.js): the page opened in a real browser
// and its player started; the media it requests becomes the item.
export async function viaBrowser(c, opts = {}) {
  // Streamlink's site plugins first (quick), then the page in a real browser.
  const sl = (opts.streamlinkOn ?? !!streamlinkPath()) ? await (opts.streamlink || streamlinkResolve)(c.url).catch(() => null) : null;
  const s = sl ? { media: [{ url: sl.url, headers: sl.headers, cookie: null }], title: null, image: null, durationSec: null }
    : (opts.browserOn ?? browserAvailable()) ? await (opts.sniff || sniffPage)(c.url, { timeoutMs: opts.browserMs ?? 25000, deadline: opts.browserDeadline ?? Infinity }) : null;
  for (const m of s?.media || []) {
    if (YT.test(m.url)) continue;
    const tracks = await (opts.probeStreams || probeMediaStreams)(m.url, { timeoutMs: 10000, headers: m.headers, cookie: m.cookie });
    const streams = tracks?.streams || [];
    const hasAudio = streams.some(x => x.codec_type === 'audio'), hasVideo = streams.some(x => x.codec_type === 'video');
    if (!hasAudio) continue; // the phone needs sound
    const live = await (opts.isLive || hlsIsLive)(m.url, { headers: m.headers, cookie: m.cookie });
    const dur = live ? null : Number(tracks?.format?.duration) || Number(s.durationSec) || null;
    if (!live && dur && dur < 5) continue;
    const item = {
      url: m.url, page: c.url, referer: m.headers?.Referer || c.url, browser: true,
      title: String(s.title || c.title || '').replace(/\s+/g, ' ').trim().slice(0, 200) || hostOf(c.url),
      site: hostOf(c.url) || c.site, siteName: null, uploader: c.source || null, description: String(c.snippet || '').slice(0, 4000),
      thumbnail: s.image || c.image || null, durationSec: live ? null : dur, uploadDate: null, views: null, tags: null,
      hasVideo: live ? false : hasVideo, hasAudio, impersonate: false, live, httpHeaders: mediaRequestHeaders(m.headers),
    };
    return { ...item, id: registerWebItem(item) };
  }
  return null;
}

// One link -> a playable item, a YouTube link ({youtube}), or null.
// A search result that is a Google redirect ("google.com/url?q=...") is the
// page it points to (the site is then named correctly too).
export function unwrapRedirect(url) {
  try {
    const u = new URL(url);
    if (/(^|\.)google\.[a-z.]+$/i.test(u.hostname) && /^\/url$/i.test(u.pathname)) {
      const t = u.searchParams.get('q') || u.searchParams.get('url');
      if (t && /^https?:\/\//i.test(t)) return t;
    }
  } catch {}
  return url;
}

// Live or recorded: a playlist without #EXT-X-ENDLIST is a live broadcast.
export async function hlsIsLive(url, { headers = {}, cookie = null, fetchImpl = fetch } = {}) {
  if (!/\.m3u8/i.test(url)) return false;
  const h = { ...mediaRequestHeaders(headers), ...(cookie ? { Cookie: cookie } : {}) };
  try {
    let text = await (await fetchImpl(url, { headers: h, signal: AbortSignal.timeout(8000) })).text();
    if (/#EXT-X-STREAM-INF/i.test(text)) {
      const line = text.split(/\r?\n/).find((l, i, a) => l && !l.startsWith('#') && /#EXT-X-STREAM-INF/i.test(a[i - 1] || ''));
      if (!line) return false;
      text = await (await fetchImpl(new URL(line.trim(), url).href, { headers: h, signal: AbortSignal.timeout(8000) })).text();
    }
    return /#EXTINF/i.test(text) && !/#EXT-X-ENDLIST/i.test(text) && !/#EXT-X-PLAYLIST-TYPE:\s*VOD/i.test(text);
  } catch { return false; }
}

export async function inspectLink(c0, opts = {}) {
  const c = { ...c0, url: unwrapRedirect(c0.url) };
  if (c.url !== c0.url && !c0.site) c.site = hostOf(c.url);
  let failure = null;
  const r = await inspectLinkPlain(c, { ...opts, onFailure: f => { failure = f; } });
  if (r) return r;
  // Nothing the downloader could read: the page in a real browser (18.11).
  const b = await viaBrowser(c, opts).catch(() => null);
  if (b) return b;
  if (failure) opts.onFailure?.(failure);
  return null;
}

async function inspectLinkPlain(c, opts = {}) {
  // One deadline includes extraction, browser-transport retry and page scan.
  // Previously each retry received a fresh 30 seconds, overrunning the call.
  const until = Date.now() + (opts.timeoutMs ?? 30000);
  const remaining = () => Math.max(0, until - Date.now());
  const runProbe = (url, extra = {}) => remaining() > 0
    ? (opts.probe || probe)(url, { ...opts, ...extra, timeoutMs: remaining() })
    : Promise.resolve({ ok: false, err: 'timeout' });
  const unavailable = result => {
    opts.onFailure?.({ reason: /403|401|forbidden|access denied|captcha|challenge/i.test(result?.err || '') ? 'access_denied' : /timeout/i.test(result?.err || '') ? 'timeout' : 'unsupported' });
    return null;
  };
  const resolved = isMakoEpisode(c.url) ? await (opts.resolveMako || resolveMakoPublic)(c.url, { timeoutMs: Math.min(15000, remaining()), ...(opts.fetchImpl ? { fetchImpl: opts.fetchImpl } : {}) }) : null;
  if (resolved?.reason === 'access_denied' && !resolved.media) return unavailable({ err: 'access denied' });
  let r = resolved?.media ? { ok: false, err: 'resolved public source' } : await runProbe(c.url, opts), impersonate = false;
  if (!r.ok && /403|cloudflare|captcha|forbidden|challenge/i.test(r.err || '')) { r = await runProbe(c.url, { ...opts, impersonate: true }); impersonate = true; }
  let page = null;
  if (!r.ok || r.info?.extractor_key === 'Generic' && !(Number(r.info?.duration) > 0) && !(r.info?.formats || []).length) {
    // Deeper: the page's own HTML (owner, 18.11: "scan every page").
    const sc = resolved?.media ? resolved : remaining() > 0 ? await (opts.scan || scanPage)(c.url, { timeoutMs: Math.min(12000, remaining()) }) : null;
    if (sc?.youtube) return { youtube: sc.youtube, title: sc.title || c.title };
    if (!sc?.media) return unavailable(r);
    page = { url: c.url, title: sc.title, image: sc.image, httpHeaders: sc.httpHeaders };
    // An advert or embedded player may appear before the actual file. Try a
    // small bounded set, retaining the same deadline and page Referer.
    for (const media of (sc.mediaUrls || [sc.media]).slice(0, 6)) {
      r = await runProbe(media, { referer: sc.httpHeaders?.Referer || c.url, httpHeaders: sc.httpHeaders }); impersonate = false;
      if (!r.ok && /403|cloudflare|captcha|forbidden|challenge/i.test(r.err || '') && remaining() > 0) {
        r = await runProbe(media, { referer: sc.httpHeaders?.Referer || c.url, httpHeaders: sc.httpHeaders, impersonate: true }); impersonate = r.ok;
      }
      if (r.ok || remaining() <= 0) break;
    }
    if (!r.ok) return unavailable(r);
  }
  const isLive = j0 => !!(j0?.is_live || j0?.live_status === 'is_live');
  // A YouTube video goes to extension 2's YouTube path; a YouTube live
  // broadcast stays here (the live relay plays it).
  if (YT.test(r.info?.webpage_url || '') && !isLive(r.info)) return { youtube: r.info.webpage_url, title: r.info.title || c.title };
  let j = r.info;
  if (j?._type === 'playlist') j = (j.entries || [])[0];
  if (!j) return null;
  const f = Array.isArray(j.formats) && j.formats.length ? j.formats : [j];
  let hasVideo = f.some(x => x.vcodec && x.vcodec !== 'none') || (!!j.width && j.vcodec !== 'none');
  let hasAudio = f.some(x => x.acodec && x.acodec !== 'none') || (j.acodec && j.acodec !== 'none') || /^(mp3|m4a|aac|opus|ogg|wav|flac)$/i.test(j.ext || '');
  if (!hasAudio && remaining() > 0) {
    const streamUrl = j.url || f.find(x => x.url)?.url;
    if (streamUrl && /^https?:\/\//i.test(streamUrl)) {
      const tracks = await (opts.probeStreams || probeMediaStreams)(streamUrl, { timeoutMs: Math.min(8000, remaining()), headers: { ...mediaRequestHeaders(j.http_headers), ...mediaRequestHeaders(page?.httpHeaders), ...(page && !page.httpHeaders?.Referer ? { Referer: page.url } : {}) } });
      hasVideo = hasVideo || !!tracks?.streams?.some(x => x.codec_type === 'video');
      hasAudio = hasAudio || !!tracks?.streams?.some(x => x.codec_type === 'audio');
      if (!Number(j.duration) && Number(tracks?.format?.duration) > 0) j = { ...j, duration: Number(tracks.format.duration) };
    }
  }
  if (!hasVideo && !hasAudio) return null;
  const live = isLive(j) || isLive(r.info); // owner, 18.11: live broadcasts are played through the relay
  if (j.extractor_key === 'Generic' && !(Number(j.duration) > 0) && !hasAudio && !hasVideo) return null;
  const durationSec = live ? null : (Number(j.duration) || null);
  if (!live && durationSec && durationSec < 5) return null;
  if (live && !hasAudio) return null;
  // From a page scan: the file is what is downloaded, the page is its website.
  const pageUrl = page ? (j.webpage_url || j.url || '') : (j.webpage_url || c.url);
  const shownUrl = page ? page.url : pageUrl;
  const bareTitle = page && (!j.title || /^[\w.-]+$/.test(String(j.title)));
  const item = {
    url: pageUrl, page: page ? page.url : null, referer: page ? page.httpHeaders?.Referer || page.url : null,
    title: String((bareTitle ? page.title || c.title : j.title) || c.title || '').replace(/\s+/g, ' ').trim().slice(0, 200) || hostOf(shownUrl),
    site: hostOf(shownUrl) || c.site, siteName: j.extractor_key && j.extractor_key !== 'Generic' ? j.extractor_key : null,
    uploader: j.uploader || j.channel || j.creator || c.source || null, description: String(j.description || c.snippet || '').slice(0, 4000),
    thumbnail: j.thumbnail || page?.image || c.image || null, durationSec, uploadDate: j.upload_date || null, views: Number.isFinite(j.view_count) ? j.view_count : null,
    tags: Array.isArray(j.tags) ? j.tags.slice(0, 30) : null, hasVideo: live ? false : hasVideo, hasAudio, impersonate, live,
    httpHeaders: { ...mediaRequestHeaders(j.http_headers), ...mediaRequestHeaders(page?.httpHeaders) },
  };
  return { ...item, id: registerWebItem(item) };
}

// The whole search: candidates from the web, then each one checked (4 at a
// time, within a total budget); YouTube links are kept apart (extension 2
// already handles YouTube through its own, richer path).
// Live broadcasts on YouTube right now: YouTube's own search with its
// "live" filter (yt-dlp reads the results page; no key needed).
export function youtubeLiveNow(q, { bin = ytdlpPath(), timeoutMs = 40000, max = 10 } = {}) {
  const words = String(q).replace(LIVE_WORDS, ' ').replace(/\s+/g, ' ').trim() || String(q);
  const url = 'https://www.youtube.com/results?search_query=' + encodeURIComponent(words) + '&sp=EgJAAQ%253D%253D';
  return new Promise(resolve => {
    const p = spawn(bin, ['--no-warnings', '--flat-playlist', '--dump-single-json', '--playlist-items', '1-' + max, '--', url], { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    const t = setTimeout(() => p.kill('SIGKILL'), timeoutMs);
    p.stdout.on('data', d => { out += d; });
    p.on('error', () => { clearTimeout(t); resolve([]); });
    p.on('close', () => {
      clearTimeout(t);
      let j = null; try { j = JSON.parse(out); } catch {}
      const list = (j?.entries || []).filter(e => e?.id && /^[A-Za-z0-9_-]{11}$/.test(e.id) && (e.live_status ? e.live_status === 'is_live' : true));
      resolve(list.map(e => {
        const item = { url: 'https://www.youtube.com/watch?v=' + e.id, title: String(e.title || '').slice(0, 200), site: 'youtube.com', uploader: e.channel || e.uploader || null,
          description: '', thumbnail: Array.isArray(e.thumbnails) && e.thumbnails.length ? e.thumbnails[e.thumbnails.length - 1].url : null, durationSec: null, uploadDate: null, views: null, tags: null,
          hasVideo: false, hasAudio: true, impersonate: false, live: true };
        return { ...item, id: registerWebItem(item) };
      }));
    });
  });
}
export const LIVE_WORDS = /(?:שידור חי|שידורים חיים|בשידור חי|בלייב|לייב|\blive\b|ערוץ חי|רדיו)/iu;
export async function searchWebMedia(q, { env = process.env, budgetMs = 90000, limit = 60, onProgress = () => {}, candidates = null, inspect = inspectLink, live = LIVE_WORDS.test(String(q)) } = {}) {
  const started = Date.now();
  const liveNow = live && !candidates ? youtubeLiveNow(q).catch(() => []) : Promise.resolve([]);
  const list = (candidates || await webCandidates(q, { env })).slice(0, 100).map(c => ({ ...c, url: unwrapRedirect(c.url) }));
  onProgress({ stage: 'checking', total: list.length, done: 0, found: 0 });
  const found = [], youtube = [], unavailable = [];
  let next = 0, done = 0;
  const worker = async () => {
    while (next < list.length && found.length < limit && Date.now() - started < budgetMs) {
      const c = list[next++];
      // Live search: YouTube links are opened too, to find the ones broadcasting now.
      if (YT.test(c.url) && !live) { youtube.push(c); done++; continue; }
      const left = budgetMs - (Date.now() - started);
      const it = left > 3000 ? await inspect(c, { timeoutMs: Math.min(30000, left), browserDeadline: started + budgetMs - 1000, onFailure: failure => unavailable.push({ title: c.title, site: c.site || hostOf(c.url), reason: failure.reason }) }).catch(() => null) : null;
      done++;
      if (it?.youtube) youtube.push({ url: it.youtube, title: it.title || c.title });
      else if (it && !found.some(x => x.id === it.id)) found.push(it);
      onProgress({ stage: 'checking', total: list.length, done, found: found.length });
    }
  };
  await Promise.all([worker(), worker(), worker(), worker(), worker()]);
  for (const it of await liveNow) if (!found.some(x => x.id === it.id)) found.unshift(it);
  return { items: found.slice(0, limit + 10), youtube, unavailable, checked: done, candidates: list.length, seconds: Math.round((Date.now() - started) / 1000) };
}
