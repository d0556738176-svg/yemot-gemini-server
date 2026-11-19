// Search the whole web for a video or recording to hear or watch (owner,
// 18.11: "search deep, every page on the internet"). Several searches run
// together: Google's video results (every site, not only YouTube) and normal
// web results for the same words and for "words + video / lesson / listen",
// so pages that only embed a player are found too. Every key is optional;
// what answers is merged, duplicates removed. The extension 2 server then
// checks each link really holds media it can download. Never throws.
const MEDIA_HINT = /(video|watch|vod|player|play|media|embed|shiur|lecture|audio|podcast|episode|mp3|mp4|m3u8|וידאו|שיעור|הרצאה|האזנה|צפייה)/i;
const SKIP = /(?:wikipedia\.org|wikimedia\.org|google\.[a-z.]+\/(?:search|maps)|spotify\.com)|\.(pdf|docx?|xlsx?|pptx?|zip|rar|exe|apk)(\?|$)|\/(search|tag|tags|category|login|signin|account)\b|facebook\.com\/(groups|pages)\//i;

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
  // Both keys, in turn: a used-up or refused key goes to the next (19.11).
  const keys = [env.TAVILY_API_KEY, env.TAVILY_BACKUP_API_KEY].map(k => String(k || '').trim()).filter(Boolean);
  for (const key of keys) {
    try {
      const r = await fetchImpl('https://api.tavily.com/search', {
        method: 'POST', signal: AbortSignal.timeout(timeoutMs),
        headers: { 'content-type': 'application/json', authorization: 'Bearer ' + key },
        body: JSON.stringify({ api_key: key, query: q, max_results: 10, search_depth: 'advanced' })
      });
      if (r.ok) { const j = await r.json(); if (j?.results?.length) return j; continue; }
    } catch { /* next key */ }
  }
  return null;
}

// Backup engines (19.11): used only when Serper answered nothing (its free
// credits can run out), so their own free quotas are kept for that case.
// Each returns [{ url, title, snippet }] or null.
async function langsearch(q, env, fetchImpl, timeoutMs) {
  const key = String(env.LANGSEARCH_API_KEY || '').trim();
  if (!key) return null;
  try {
    const r = await fetchImpl('https://api.langsearch.com/v1/web-search', {
      method: 'POST', signal: AbortSignal.timeout(timeoutMs),
      headers: { 'content-type': 'application/json', authorization: 'Bearer ' + key },
      body: JSON.stringify({ query: q, freshness: 'noLimit', summary: false, count: 10 })
    });
    if (!r.ok) return null;
    const j = await r.json();
    const v = j?.data?.webPages?.value || j?.webPages?.value || [];
    return v.map(x => ({ url: x.url, title: x.name, snippet: x.snippet })).filter(x => x.url);
  } catch { return null; }
}
async function jina(q, env, fetchImpl, timeoutMs) {
  const key = String(env.JINA_API_KEY || '').trim();
  if (!key) return null;
  try {
    const r = await fetchImpl('https://s.jina.ai/?q=' + encodeURIComponent(q), {
      signal: AbortSignal.timeout(Math.max(timeoutMs, 15000)),
      headers: { authorization: 'Bearer ' + key, accept: 'application/json', 'x-respond-with': 'no-content' }
    });
    if (!r.ok) return null;
    const j = await r.json();
    return (j?.data || []).map(x => ({ url: x.url, title: x.title, snippet: x.description || x.content })).filter(x => x.url);
  } catch { return null; }
}
async function firecrawl(q, env, fetchImpl, timeoutMs) {
  const key = String(env.FIRECRAWL_API_KEY || '').trim();
  if (!key) return null;
  try {
    const r = await fetchImpl('https://api.firecrawl.dev/v1/search', {
      method: 'POST', signal: AbortSignal.timeout(Math.max(timeoutMs, 15000)),
      headers: { 'content-type': 'application/json', authorization: 'Bearer ' + key },
      body: JSON.stringify({ query: q, limit: 10 })
    });
    if (!r.ok) return null;
    const j = await r.json();
    const d = Array.isArray(j?.data) ? j.data : (j?.data?.web || []);
    return d.map(x => ({ url: x.url, title: x.title, snippet: x.description })).filter(x => x.url);
  } catch { return null; }
}

// What answered the last searches (booleans only), for /web-search-status.
export const searchStatus = [];

export async function searchWebVideos(query, { env = process.env, fetchImpl = fetch, timeoutMs = 9000, max = 30 } = {}) {
  const q = String(query || '').replace(/\s+/g, ' ').trim().slice(0, 200);
  if (!q) return { items: [] };
  const base = { gl: 'il', hl: 'iw' };
  const [vids, vidsEn, web, webVideo, webLesson, webDownload, webRecording, tv] = await Promise.all([
    serper('videos', { q, ...base, num: 20 }, env, fetchImpl, timeoutMs),
    serper('videos', { q, num: 10 }, env, fetchImpl, timeoutMs),
    serper('search', { q, ...base, num: 20 }, env, fetchImpl, timeoutMs),
    serper('search', { q: q + ' וידאו', ...base, num: 10 }, env, fetchImpl, timeoutMs),
    serper('search', { q: q + ' שיעור להאזנה', ...base, num: 10 }, env, fetchImpl, timeoutMs),
    serper('search', { q: q + ' mp3 הורדה', ...base, num: 10 }, env, fetchImpl, timeoutMs),
    serper('search', { q: q + ' הקלטה', ...base, num: 10 }, env, fetchImpl, timeoutMs),
    tavily(q + ' video', env, fetchImpl, timeoutMs),
  ]);
  const out = [], seen = new Set();
  const add = (x, from, weight) => {
    const url = String(x.link || x.url || '').trim();
    if (!/^https?:\/\//i.test(url) || SKIP.test(url)) return;
    // Query strings frequently identify the video. Strip tracking fields only;
    // removing every query collapsed all YouTube watch links into one result.
    let canonical;
    try { canonical = new URL(url); } catch { return; }
    canonical.hash = '';
    for (const k of [...canonical.searchParams.keys()]) if (/^(?:utm_.+|fbclid|gclid)$/i.test(k)) canonical.searchParams.delete(k);
    canonical.searchParams.sort();
    const key = canonical.href.replace(/\/$/, '');
    if (seen.has(key)) return;
    seen.add(key);
    out.push({ url, title: clean(x.title), site: hostOf(url), source: x.source || x.channel || null, date: x.date || null,
      duration: x.duration || null, image: x.imageUrl || x.thumbnailUrl || null, snippet: String(x.snippet || x.content || '').slice(0, 200), from, weight });
  };
  for (const x of vids?.videos || []) add(x, 'video', 3);
  for (const x of vidsEn?.videos || []) add(x, 'video-en', 2);
  for (const r of [web, webVideo, webLesson, webDownload, webRecording]) for (const x of r?.organic || []) add(x, 'web', MEDIA_HINT.test(x.link + ' ' + x.title) ? 2 : 1);
  for (const x of tv?.results || []) add(x, 'tavily', MEDIA_HINT.test(x.url + ' ' + x.title) ? 2 : 1);
  // Serper gave nothing (credits used up or down): the backup engines.
  let backups = null;
  if (!(vids?.videos?.length || web?.organic?.length)) {
    const [ls, ls2, jn, fc] = await Promise.all([
      langsearch(q, env, fetchImpl, timeoutMs), langsearch(q + ' וידאו', env, fetchImpl, timeoutMs),
      jina(q, env, fetchImpl, timeoutMs), firecrawl(q, env, fetchImpl, timeoutMs),
    ]);
    backups = { langsearch: !!(ls?.length || ls2?.length), jina: !!jn?.length, firecrawl: !!fc?.length };
    for (const x of [...(ls || []), ...(ls2 || []), ...(jn || []), ...(fc || [])]) add(x, 'backup', MEDIA_HINT.test(x.url + ' ' + x.title) ? 2 : 1);
  }
  // Video results first, then pages that look like they hold media; the
  // original order of each engine is kept within the same weight.
  const items = out.map((x, i) => ({ ...x, i })).sort((a, b) => b.weight - a.weight || a.i - b.i).slice(0, max).map(({ i, weight, ...x }) => x);
  const engines = { videos: !!vids?.videos?.length, web: !!web?.organic?.length, tavily: !!tv?.results?.length, ...(backups ? { backups } : {}) };
  searchStatus.push({ at: new Date().toISOString(), items: items.length, engines });
  if (searchStatus.length > 30) searchStatus.shift();
  return { items, engines };
}
