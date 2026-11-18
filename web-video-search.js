// Search the whole web for a video or recording to hear or watch (owner,
// 18.11: "search deep, every page on the internet"). Several searches run
// together: Google's video results (every site, not only YouTube) and normal
// web results for the same words and for "words + video / lesson / listen",
// so pages that only embed a player are found too. Every key is optional;
// what answers is merged, duplicates removed. The extension 2 server then
// checks each link really holds media it can download. Never throws.
const MEDIA_HINT = /(video|watch|vod|player|play|media|embed|shiur|lecture|audio|podcast|episode|mp3|mp4|m3u8|וידאו|שיעור|הרצאה|האזנה|צפייה)/i;
const SKIP = /\.(pdf|docx?|xlsx?|pptx?|zip|rar|exe|apk)(\?|$)|\/(search|tag|tags|category|login|signin|account)\b|facebook\.com\/(groups|pages)\//i;

const clean = t => String(t || '').replace(/\s*[-|–]\s*(YouTube|Vimeo)\s*$/i, '').replace(/\s+/g, ' ').trim();
const hostOf = u => { try { return new URL(u).hostname.replace(/^www\./, ''); } catch { return ''; } };

async function serper(path, body, env, fetchImpl, timeoutMs) {
  const keys = Object.keys(env).filter(k => /^SERPER_API_KEY(_\w+)?$/.test(k)).sort().map(k => String(env[k] || '').trim()).filter(Boolean);
  for (const key of keys) {
    try {
      const r = await fetchImpl('https://google.serper.dev/' + path, {
        method: 'POST', signal: AbortSignal.timeout(timeoutMs),
        headers: { 'X-API-KEY': key, 'content-type': 'application/json' }, body: JSON.stringify(body)
      });
      if (r.status === 401 || r.status === 403 || r.status === 429) continue; // next key
      if (!r.ok) return null;
      return await r.json();
    } catch { /* next key */ }
  }
  return null;
}

async function tavily(q, env, fetchImpl, timeoutMs) {
  const key = String(env.TAVILY_API_KEY || env.TAVILY_BACKUP_API_KEY || '').trim();
  if (!key) return null;
  try {
    const r = await fetchImpl('https://api.tavily.com/search', {
      method: 'POST', signal: AbortSignal.timeout(timeoutMs),
      headers: { 'content-type': 'application/json', authorization: 'Bearer ' + key },
      body: JSON.stringify({ api_key: key, query: q, max_results: 10, search_depth: 'advanced' })
    });
    return r.ok ? await r.json() : null;
  } catch { return null; }
}

export async function searchWebVideos(query, { env = process.env, fetchImpl = fetch, timeoutMs = 9000, max = 30 } = {}) {
  const q = String(query || '').replace(/\s+/g, ' ').trim().slice(0, 200);
  if (!q) return { items: [] };
  const base = { gl: 'il', hl: 'iw' };
  const [vids, vidsEn, web, webVideo, webLesson, tv] = await Promise.all([
    serper('videos', { q, ...base, num: 20 }, env, fetchImpl, timeoutMs),
    serper('videos', { q, num: 10 }, env, fetchImpl, timeoutMs),
    serper('search', { q, ...base, num: 20 }, env, fetchImpl, timeoutMs),
    serper('search', { q: q + ' וידאו', ...base, num: 10 }, env, fetchImpl, timeoutMs),
    serper('search', { q: q + ' שיעור להאזנה', ...base, num: 10 }, env, fetchImpl, timeoutMs),
    tavily(q + ' video', env, fetchImpl, timeoutMs),
  ]);
  const out = [], seen = new Set();
  const add = (x, from, weight) => {
    const url = String(x.link || x.url || '').trim();
    if (!/^https?:\/\//i.test(url) || SKIP.test(url)) return;
    const key = url.replace(/[#?].*$/, '').replace(/\/+$/, '').toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    out.push({ url, title: clean(x.title), site: hostOf(url), source: x.source || x.channel || null, date: x.date || null,
      duration: x.duration || null, image: x.imageUrl || x.thumbnailUrl || null, snippet: String(x.snippet || x.content || '').slice(0, 200), from, weight });
  };
  for (const x of vids?.videos || []) add(x, 'video', 3);
  for (const x of vidsEn?.videos || []) add(x, 'video-en', 2);
  for (const r of [web, webVideo, webLesson]) for (const x of r?.organic || []) add(x, 'web', MEDIA_HINT.test(x.link + ' ' + x.title) ? 2 : 1);
  for (const x of tv?.results || []) add(x, 'tavily', MEDIA_HINT.test(x.url + ' ' + x.title) ? 2 : 1);
  // Video results first, then pages that look like they hold media; the
  // original order of each engine is kept within the same weight.
  const items = out.map((x, i) => ({ ...x, i })).sort((a, b) => b.weight - a.weight || a.i - b.i).slice(0, max).map(({ i, weight, ...x }) => x);
  return { items, engines: { videos: !!vids, web: !!web, tavily: !!tv } };
}
