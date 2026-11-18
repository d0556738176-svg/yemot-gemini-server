// Whole-web search for extension 2 (keys 5/6) and extensions 1/3 (owner,
// 18.11). The main server searches the web (it holds the search keys); here
// every link found is opened with the downloader the way a browser would, and
// only links that really hold audio or video this server can download are
// kept, with their real title, site, length and picture. Sites that block
// automated readers (Cloudflare) are tried again posing as a real browser.
import { spawn } from 'node:child_process';
import { ytdlpPath } from './youtube-direct.js';
import { registerWebItem } from './web-items.js';

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

function probe(url, { bin = ytdlpPath(), impersonate = false, timeoutMs = 30000 } = {}) {
  return new Promise(resolve => {
    const args = ['--no-warnings', '--dump-single-json', '--no-playlist', '--playlist-items', '1', '--socket-timeout', '15', ...(impersonate ? ['--impersonate', 'chrome'] : []), '--', url];
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

// One link -> a playable item, or null.
export async function inspectLink(c, opts = {}) {
  let r = await probe(c.url, opts), impersonate = false;
  if (!r.ok && /403|cloudflare|captcha|forbidden|challenge/i.test(r.err || '')) { r = await probe(c.url, { ...opts, impersonate: true }); impersonate = true; }
  if (!r.ok) return null;
  let j = r.info;
  if (j?._type === 'playlist') j = (j.entries || [])[0];
  if (!j) return null;
  const f = Array.isArray(j.formats) && j.formats.length ? j.formats : [j];
  const hasVideo = f.some(x => x.vcodec && x.vcodec !== 'none') || (!!j.width && j.vcodec !== 'none');
  const hasAudio = f.some(x => x.acodec && x.acodec !== 'none') || (j.acodec && j.acodec !== 'none') || /^(mp3|m4a|aac|opus|ogg|wav|flac)$/i.test(j.ext || '');
  if (!hasVideo && !hasAudio) return null;
  if (j.is_live || j.live_status === 'is_live') return null; // a live broadcast is not a file to download
  if (j.extractor_key === 'Generic' && !(Number(j.duration) > 0) && !hasAudio && !hasVideo) return null;
  const durationSec = Number(j.duration) || null;
  if (durationSec && durationSec < 5) return null;
  const pageUrl = j.webpage_url || c.url;
  const item = {
    url: pageUrl, title: String(j.title || c.title || '').replace(/\s+/g, ' ').trim().slice(0, 200) || c.title || hostOf(pageUrl),
    site: hostOf(pageUrl) || c.site, siteName: j.extractor_key && j.extractor_key !== 'Generic' ? j.extractor_key : null,
    uploader: j.uploader || j.channel || j.creator || c.source || null, description: String(j.description || c.snippet || '').slice(0, 4000),
    thumbnail: j.thumbnail || c.image || null, durationSec, uploadDate: j.upload_date || null, views: Number.isFinite(j.view_count) ? j.view_count : null,
    tags: Array.isArray(j.tags) ? j.tags.slice(0, 30) : null, hasVideo, hasAudio, impersonate,
  };
  return { ...item, id: registerWebItem(item) };
}

// The whole search: candidates from the web, then each one checked (4 at a
// time, within a total budget); YouTube links are kept apart (extension 2
// already handles YouTube through its own, richer path).
export async function searchWebMedia(q, { env = process.env, budgetMs = 90000, limit = 30, onProgress = () => {}, candidates = null, inspect = inspectLink } = {}) {
  const started = Date.now();
  const list = (candidates || await webCandidates(q, { env })).slice(0, 60);
  onProgress({ stage: 'checking', total: list.length, done: 0, found: 0 });
  const found = [], youtube = [];
  let next = 0, done = 0;
  const worker = async () => {
    while (next < list.length && found.length < limit && Date.now() - started < budgetMs) {
      const c = list[next++];
      if (YT.test(c.url)) { youtube.push(c); done++; continue; }
      const left = budgetMs - (Date.now() - started);
      const it = left > 3000 ? await inspect(c, { timeoutMs: Math.min(30000, left) }).catch(() => null) : null;
      done++;
      if (it && !found.some(x => x.id === it.id)) found.push(it);
      onProgress({ stage: 'checking', total: list.length, done, found: found.length });
    }
  };
  await Promise.all([worker(), worker(), worker(), worker(), worker()]);
  return { items: found.slice(0, limit), youtube, checked: done, candidates: list.length, seconds: Math.round((Date.now() - started) / 1000) };
}
