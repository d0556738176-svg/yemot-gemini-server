// Owner, 25.11: key 8 must always say the real YouTube channel, with the
// details fresh from YouTube. One source alone was not enough: the YouTube
// Data API (one key) sometimes gave nothing (quota or a slow answer), and then
// the channel was silently left out. Now, in order, until everything is known:
//   1. the YouTube Data API with every configured key, at the same time
//      (the first answer wins; videos.list costs 1 unit a key);
//   2. YouTube's public oEmbed page (title and channel, no key needed);
//   3. yt-dlp on our server (channel, length, upload date, views);
//   4. what we saved when the file was made (the channel's feed name).
// Answers are kept 10 minutes, so pressing 8 again is instant and still fresh.
import { spawn } from 'node:child_process';
import { fetchVideoFacts } from './youtube-video-facts.js';
import { youtubeKeysFrom } from './youtube-ivr.js';
import { ytdlpPath } from './youtube-direct.js';

const cache = new Map();
export const metaLog = []; // last answers: which sources gave the channel (for /news-status)
const TTL = 10 * 60 * 1000;

async function fromApi(videoId, env, fetchImpl) {
  // No key: still asked once (a website's own item needs no key).
  const keys = youtubeKeysFrom(env).length ? youtubeKeysFrom(env) : [''];
  const tries = keys.map(k => fetchVideoFacts(videoId, { ...env, YOUTUBE_API_KEY: k, YOUTUBE_DURATION_TIMEOUT_MS: '6000' }, fetchImpl)
    .then(f => f?.channel || f?.title ? f : Promise.reject(new Error('empty'))));
  return Promise.any(tries).catch(() => null);
}

export async function fromOembed(videoId, fetchImpl = fetch) {
  const u = 'https://www.youtube.com/oembed?format=json&url=' + encodeURIComponent('https://www.youtube.com/watch?v=' + videoId);
  const r = await fetchImpl(u, { signal: AbortSignal.timeout(5000) });
  if (!r.ok) return null;
  const j = await r.json().catch(() => null);
  return j?.author_name || j?.title ? { channel: j.author_name || null, title: j.title || null } : null;
}

export function parseYtdlp(out) {
  const line = String(out || '').trim().split('\n').filter(Boolean).pop() || '';
  const [channel, dur, date, views, ...t] = line.split('\u0001');
  const num = x => (/^\d+$/.test(String(x || '')) ? Number(x) : null);
  const d = /^(\d{4})(\d\d)(\d\d)$/.exec(String(date || ''));
  return { channel: channel && channel !== 'NA' ? channel : null, durationSeconds: num(dur), viewCount: num(views),
    publishedAt: d ? d[1] + '-' + d[2] + '-' + d[3] + 'T12:00:00Z' : null, title: t.join('\u0001') && t.join('\u0001') !== 'NA' ? t.join('\u0001') : null, dateOnly: !!d };
}
export function fromYtdlp(videoId, bin = ytdlpPath(), timeoutMs = 25000) {
  return new Promise(resolve => {
    const fmt = ['channel', 'duration', 'upload_date', 'view_count', 'title'].map(k => '%(' + k + ')s').join('\u0001');
    const p = spawn(bin, ['--skip-download', '--no-warnings', '--no-playlist', '--print', fmt, 'https://www.youtube.com/watch?v=' + videoId], { stdio: ['ignore', 'pipe', 'ignore'] });
    let o = ''; const t = setTimeout(() => p.kill('SIGKILL'), timeoutMs);
    p.stdout.on('data', d => { o += d; });
    p.on('error', () => { clearTimeout(t); resolve(null); });
    p.on('close', c => { clearTimeout(t); resolve(c === 0 ? parseYtdlp(o) : null); });
  });
}

// facts: { title, channel, durationSeconds, publishedAt, viewCount, description, ... , sources: [...] }
export async function videoMeta(videoId, { hintChannel = '', hintTitle = '', env = process.env, fetchImpl = fetch, ytdlp = fromYtdlp, log = console } = {}) {
  const c = cache.get(videoId);
  if (c && Date.now() - c.at < TTL) return { ...c.facts, hintChannel: hintChannel || c.facts.hintChannel };
  const sources = [];
  let f = await fromApi(videoId, env, fetchImpl).catch(() => null);
  if (f) sources.push('api'); else f = {};
  if (!f.channel || !f.title) {
    const o = await fromOembed(videoId, fetchImpl).catch(() => null);
    if (o) { sources.push('oembed'); f.channel ||= o.channel; f.title ||= o.title; }
  }
  if (!f.channel || !f.durationSeconds || !f.publishedAt) {
    const y = await ytdlp(videoId).catch(() => null);
    if (y) {
      sources.push('yt-dlp');
      f.channel ||= y.channel; f.title ||= y.title; f.durationSeconds ||= y.durationSeconds;
      if (!f.publishedAt && y.publishedAt) { f.publishedAt = y.publishedAt; f.dateOnly = true; }
      if (f.viewCount == null) f.viewCount = y.viewCount;
    }
  }
  if (!f.channel && hintChannel) { f.channel = hintChannel; sources.push('saved'); }
  f.title ||= hintTitle || null;
  f.sources = sources;
  metaLog.unshift({ at: new Date().toISOString(), videoId, channel: f.channel || null, sources }); metaLog.length = Math.min(metaLog.length, 30);
  if (!f.channel) log.warn?.('[KEY8] channel unknown from every source', { videoId, sources });
  if (sources.some(s => s !== 'saved')) cache.set(videoId, { at: Date.now(), facts: f });
  if (cache.size > 500) cache.delete(cache.keys().next().value);
  return f;
}
export function _clearMetaCache() { cache.clear(); }
