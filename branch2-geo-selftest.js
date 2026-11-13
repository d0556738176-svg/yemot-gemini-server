// Videos limited to Israel (owner, 13.11: "solve it at the root"). Our main
// engine (johnvc) runs outside Israel and has no country option, so YouTube
// answers "unavailable". This live test finds a short Israel-only video and
// tries engines that can download through a residential (home) connection in
// Israel, each run capped in cost, and logs which one really delivers a file.
// Runs once per engine (a mark file in Yemot); never touches callers' jobs.
import { apifyTokens } from './youtube-apify-source.js';

const API = 'https://api.apify.com/v2';
const log = (...a) => console.info('[GEO_TEST]', ...a);

const IL_RESIDENTIAL = { useApifyProxy: true, apifyProxyGroups: ['RESIDENTIAL'], apifyProxyCountry: 'IL' };
// Round 1-2 (13.11): dc_solutions 403 even with a proxy; marielise has no IL
// in its country list (auto = not Israel). Round 3: engines that take Apify's
// standard proxy setting, so the country can be Israel.
export const GEO_CANDIDATES = [
  { id: 'web.harvester~youtube-downloader', input: url => ({ youtubeUrls: [{ url }], maxRequestRetries: 5, proxyConfiguration: IL_RESIDENTIAL }) },
  { id: 'hipersoft~youtube-downloader', input: url => ({ videoUrls: [url], format: 'mp3', proxyConfiguration: IL_RESIDENTIAL }) },
];

function iso8601Seconds(d) {
  const m = /PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?/.exec(String(d || ''));
  return m ? (+m[1] || 0) * 3600 + (+m[2] || 0) * 60 + (+m[3] || 0) : 0;
}

// A short public video that YouTube allows only in Israel (not in the US).
// Real Israel-only videos callers chose (logs 09.11-11.11), checked again live.
export const KNOWN_ISRAEL_ONLY = ['HHkeMlB4yNI', 'FWx3ZbgLtR0', 'SGbRCbhWK_8', 'O-lvBFC5S0A', 'Z2Uq4aX2KPs', 'HF-NQbc7wY8', 'TQ4VtrIlhak', 'KMR00mcwuHw', 'wVw3XFpkDB8'];
export async function findIsraelOnlyVideo(key, queries = ['כאן 11 פרק', 'כאן חדשות']) {
  {
    const v = new URL('https://www.googleapis.com/youtube/v3/videos');
    Object.entries({ part: 'contentDetails,snippet', id: KNOWN_ISRAEL_ONLY.join(','), key }).forEach(([k, val]) => v.searchParams.set(k, val));
    const vj = await (await fetch(v)).json();
    const hits = (vj.items || []).map(it => ({ videoId: it.id, title: it.snippet?.title, seconds: iso8601Seconds(it.contentDetails?.duration), allowed: it.contentDetails?.regionRestriction?.allowed || null }))
      .filter(x => x.allowed && x.allowed.includes('IL') && !x.allowed.includes('US') && x.seconds >= 20).sort((a, b) => a.seconds - b.seconds);
    if (hits.length) return hits[0];
  }
  for (const q of queries) {
    const s = new URL('https://www.googleapis.com/youtube/v3/search');
    Object.entries({ part: 'snippet', q, type: 'video', maxResults: '50', regionCode: 'IL', key }).forEach(([k, v]) => s.searchParams.set(k, v));
    const sj = await (await fetch(s)).json();
    const ids = (sj.items || []).map(i => i.id?.videoId).filter(Boolean);
    if (!ids.length) continue;
    const v = new URL('https://www.googleapis.com/youtube/v3/videos');
    Object.entries({ part: 'contentDetails,snippet', id: ids.join(','), key }).forEach(([k, val]) => v.searchParams.set(k, val));
    const vj = await (await fetch(v)).json();
    const hits = (vj.items || []).map(it => ({ videoId: it.id, title: it.snippet?.title, seconds: iso8601Seconds(it.contentDetails?.duration), allowed: it.contentDetails?.regionRestriction?.allowed || null, blocked: it.contentDetails?.regionRestriction?.blocked || null }))
      .filter(x => (x.allowed && x.allowed.includes('IL') && !x.allowed.includes('US')) || (x.blocked && x.blocked.includes('US') && !x.blocked.includes('IL')))
      .filter(x => x.seconds >= 20 && x.seconds <= 600)
      .sort((a, b) => a.seconds - b.seconds);
    if (hits.length) return hits[0];
  }
  return null;
}

async function api(token, path, init = {}) {
  const r = await fetch(API + path, { ...init, headers: { authorization: 'Bearer ' + token, 'content-type': 'application/json', ...(init.headers || {}) }, signal: AbortSignal.timeout(60000) });
  const text = await r.text();
  let j = null; try { j = JSON.parse(text); } catch { /* log text */ }
  if (!r.ok) throw Object.assign(new Error('apify ' + r.status + ' ' + text.slice(0, 200)), { status: r.status });
  return j ?? text;
}

export async function tryEngine(token, cand, url, maxChargeUsd = 0.3) {
  const started = await api(token, '/acts/' + cand.id + '/runs?maxTotalChargeUsd=' + maxChargeUsd + '&timeout=900&memory=2048', { method: 'POST', body: JSON.stringify(cand.input(url)) });
  const runId = started.data.id;
  let run = started.data;
  for (let i = 0; i < 90 && !['SUCCEEDED', 'FAILED', 'ABORTED', 'TIMED-OUT'].includes(run.status); i++) {
    await new Promise(r => setTimeout(r, 10000));
    run = (await api(token, '/actor-runs/' + runId)).data;
  }
  const items = await api(token, '/datasets/' + run.defaultDatasetId + '/items?clean=1&limit=5').catch(() => []);
  const row = Array.isArray(items) ? items[0] || {} : {};
  const link = row.downloadUrl || row.fileUrl || row.download_link || row.url_download || row.mp3Url || row.audioUrl || row.fileLink || row.file?.url || null;
  let bytes = null;
  if (link) { try { const h = await fetch(link, { method: 'HEAD', signal: AbortSignal.timeout(30000) }); bytes = Number(h.headers.get('content-length')) || null; } catch { /* keep null */ } }
  let tail = '';
  if (run.status !== 'SUCCEEDED' || !link) tail = String(await api(token, '/logs/' + runId).catch(() => '')).slice(-1500);
  return { engine: cand.id, status: run.status, usd: run.usageTotalUsd ?? null, charged: run.chargedEventCounts || null, ok: !!(link && bytes && bytes > 10000), bytes, rowKeys: Object.keys(row).slice(0, 25), row: JSON.stringify(row).slice(0, 700), error: row.error || row.errorCode || row.errorMessage || null, proxy: { enabled: row.residentialProxyEnabled, used: row.residentialProxyUsed }, logTail: tail };
}

export async function runGeoSelftest({ readMark, writeMark, env = process.env } = {}) {
  const token = apifyTokens(env)[0];
  const key = String(env.YOUTUBE_API_KEY || '').trim();
  if (!token || !key) return log('missing keys', { apify: !!token, youtube: !!key });
  const video = await findIsraelOnlyVideo(key);
  log('Israel-only test video', video);
  if (!video) return;
  const url = 'https://www.youtube.com/watch?v=' + video.videoId;
  for (const cand of GEO_CANDIDATES) {
    const MARK = 'ivr2:/2/selftest/geo_' + cand.id.replace(/[^A-Za-z0-9]/g, '_') + '_v4.json';
    if (await readMark(MARK).catch(() => null)) continue;
    try {
      const res = await tryEngine(token, cand, url, Math.min(1.2, Math.max(0.5, Math.ceil(video.seconds / 60) * 0.03 + 0.35)));
      log('result', JSON.stringify({ video: video.videoId, seconds: video.seconds, ...res }));
      await writeMark(MARK, { at: new Date().toISOString(), video, ...res }).catch(() => {});
    } catch (e) {
      log('engine could not start', { engine: cand.id, message: String(e?.message || e).slice(0, 300) });
      await writeMark(MARK, { at: new Date().toISOString(), startError: String(e?.message || e).slice(0, 300) }).catch(() => {});
    }
  }
}
