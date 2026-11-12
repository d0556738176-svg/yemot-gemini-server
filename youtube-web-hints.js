// Misheard names in extension 2 (owner, 12.11: "I say the name and it does
// not find the song"). Speech recognition often spells singers' names wrong
// (live: four tries, each name spelled differently), and a language model
// alone does not know new names, so it passed the mistakes on unchanged.
// A web search engine corrects spelling the way people type, so the same
// words are sent to a web search limited to YouTube: the video links it
// returns are real candidates, and its result titles (correctly spelled) are
// given to the rewrite model as hints. Every provider is optional; the
// first one with a key that answers is used. Never throws.
const YT_ID = /(?:youtube\.com\/(?:watch\?(?:[^#\s]*&)?v=|shorts\/|embed\/|live\/)|youtu\.be\/)([A-Za-z0-9_-]{11})/;

export function videoIdFromUrl(url) {
  const m = YT_ID.exec(String(url || ''));
  return m ? m[1] : null;
}

const cleanTitle = t => String(t || '').replace(/\s*[-|–]\s*YouTube\s*$/i, '').trim();

async function serper(q, env, fetchImpl, timeoutMs) {
  const key = String(env.SERPER_API_KEY || '').trim();
  if (!key) return null;
  const r = await fetchImpl('https://google.serper.dev/search', {
    method: 'POST', signal: AbortSignal.timeout(timeoutMs),
    headers: { 'X-API-KEY': key, 'content-type': 'application/json' },
    body: JSON.stringify({ q: q + ' site:youtube.com', gl: 'il', hl: 'iw', num: 10 }),
  });
  if (!r.ok) throw new Error('serper ' + r.status);
  const j = await r.json();
  const items = [...(j.videos || []), ...(j.organic || [])].map(x => ({ url: x.link, title: x.title }));
  return { items, corrected: j.searchParameters?.correctedQuery || j.spellingFix || null };
}

async function tavily(q, env, fetchImpl, timeoutMs) {
  const key = String(env.TAVILY_API_KEY || env.TAVILY_BACKUP_API_KEY || '').trim();
  if (!key) return null;
  const r = await fetchImpl('https://api.tavily.com/search', {
    method: 'POST', signal: AbortSignal.timeout(timeoutMs),
    headers: { 'content-type': 'application/json', authorization: 'Bearer ' + key },
    body: JSON.stringify({ api_key: key, query: q + ' יוטיוב', include_domains: ['youtube.com'], max_results: 10 }),
  });
  if (!r.ok) throw new Error('tavily ' + r.status);
  const j = await r.json();
  return { items: (j.results || []).map(x => ({ url: x.url, title: x.title })), corrected: null };
}

async function langsearch(q, env, fetchImpl, timeoutMs) {
  const key = String(env.LANGSEARCH_API_KEY || '').trim();
  if (!key) return null;
  const r = await fetchImpl('https://api.langsearch.com/v1/web-search', {
    method: 'POST', signal: AbortSignal.timeout(timeoutMs),
    headers: { authorization: 'Bearer ' + key, 'content-type': 'application/json' },
    body: JSON.stringify({ query: q + ' site:youtube.com', count: 10 }),
  });
  if (!r.ok) throw new Error('langsearch ' + r.status);
  const j = await r.json();
  return { items: (j.data?.webPages?.value || []).map(x => ({ url: x.url, title: x.name })), corrected: null };
}

// A service without its own web keys (the extension 2 server) asks the main
// server, which holds them; a shared secret set only in Render protects it.
async function viaMain(q, env, fetchImpl, timeoutMs) {
  const secret = String(env.WEB_HINTS_SECRET || '').trim();
  if (!secret || env.WEB_HINTS_LOCAL_ONLY === '1') return null;
  const base = String(env.WEB_HINTS_URL || 'https://yemot-gemini-server.onrender.com').replace(/\/+$/, '');
  const r = await fetchImpl(base + '/internal/web-hints', {
    method: 'POST', signal: AbortSignal.timeout(timeoutMs + 1500),
    headers: { 'content-type': 'application/json', 'x-web-hints-secret': secret },
    body: JSON.stringify({ q }),
  });
  if (!r.ok) throw new Error('main ' + r.status);
  const j = await r.json();
  if (!j?.videos && !j?.titles) return null;
  return { items: [...(j.videos || []).map(v => ({ url: 'https://www.youtube.com/watch?v=' + v.videoId, title: v.title })), ...(j.titles || []).map(t => ({ url: '', title: t }))], corrected: j.corrected || null, via: j.provider };
}

const PROVIDERS = [['serper', serper], ['tavily', tavily], ['langsearch', langsearch], ['main', viaMain]];

export function configuredWebHintProviders(env = process.env) {
  return { main: !!String(env.WEB_HINTS_SECRET || '').trim(), serper: !!String(env.SERPER_API_KEY || '').trim(), tavily: !!String(env.TAVILY_API_KEY || env.TAVILY_BACKUP_API_KEY || '').trim(), langsearch: !!String(env.LANGSEARCH_API_KEY || '').trim() };
}

// { videos: [{videoId, title}], titles: [...], corrected, provider } or null.
export async function webYouTubeHints(spoken, { env = process.env, fetchImpl = fetch, timeoutMs = Number(env.WEB_HINTS_TIMEOUT_MS || 3500), localOnly = false } = {}) {
  const q = String(spoken || '').trim();
  if (!q) return null;
  for (const [name, fn] of PROVIDERS) {
    if (localOnly && name === 'main') continue;
    try {
      const out = await fn(q, env, fetchImpl, timeoutMs);
      if (!out) continue;
      const seen = new Set(), videos = [];
      for (const it of out.items) {
        const id = videoIdFromUrl(it.url);
        if (id && !seen.has(id)) { seen.add(id); videos.push({ videoId: id, title: cleanTitle(it.title) }); }
      }
      const titles = [...new Set(out.items.map(i => cleanTitle(i.title)).filter(Boolean))].slice(0, 8);
      if (!videos.length && !titles.length) continue;
      return { videos, titles, corrected: out.corrected || null, provider: out.via ? name + ':' + out.via : name };
    } catch (e) {
      console.warn('[YouTube IVR] web hints provider failed', { provider: name, message: String(e?.message || e).slice(0, 120) });
    }
  }
  return null;
}

// Full result objects (like the YouTube search's) for video ids found on the web.
export async function videosByIds(ids, { apiKey, fetchImpl = fetch, timeoutMs = 8000 } = {}) {
  const list = [...new Set(ids)].slice(0, 20);
  if (!list.length || !apiKey) return [];
  const u = new URL('https://www.googleapis.com/youtube/v3/videos');
  u.searchParams.set('part', 'snippet'); u.searchParams.set('id', list.join(',')); u.searchParams.set('key', apiKey);
  const r = await fetchImpl(u, { signal: AbortSignal.timeout(timeoutMs) });
  if (!r.ok) return [];
  const j = await r.json();
  const byId = new Map((j.items || []).map(it => [it.id, {
    videoId: it.id, title: String(it.snippet?.title || 'ללא כותרת'), channelTitle: String(it.snippet?.channelTitle || 'ערוץ לא ידוע'),
    publishedAt: it.snippet?.publishedAt || null, description: String(it.snippet?.description || ''),
  }]));
  return list.map(id => byId.get(id)).filter(Boolean);
}
