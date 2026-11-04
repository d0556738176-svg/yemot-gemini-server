// One-time diagnostic (04.11): why did the engine answer "This video is
// unavailable" for videos that do appear on YouTube? Logs, without keys:
//  1. What YouTube itself says (videos.list status + regionRestriction).
//  2. The engine's full error row and the relevant log lines of the failed run
//     (GET only, no new paid run).
//  3. A free metadataOnly engine run (failed/metadata rows are not charged).
import { apifyTokens, redactProviderDiagnostic } from './youtube-apify-source.js';

const TAG = '[BRANCH2_UNAVAILABLE_PROBE]';
const MARKER = 'ivr2:/2/selftest/unavailable_probe_v1.json';
const CASES = [
  { videoId: '7De3QZfnUao', runId: 'NJY70daYWzATYx3Ev' },
  { videoId: 'Ai2grFbKcDo', runId: null },
];

export async function runUnavailableProbe(env = process.env) {
  if (String(env.BRANCH2_UNAVAILABLE_PROBE || 'on').toLowerCase() === 'off') return;
  const p = (await import('./youtube-authorized-playback.js'))._pipeline;
  if (await p.readCacheJson(MARKER).catch(() => null)) return;
  const tokens = apifyTokens(env);
  const key = String(env.YOUTUBE_API_KEY || '').trim();
  const summary = [];
  for (const c of CASES) {
    const out = { videoId: c.videoId };
    try {
      if (key) {
        const u = new URL('https://www.googleapis.com/youtube/v3/videos');
        u.searchParams.set('part', 'status,contentDetails,snippet');
        u.searchParams.set('id', c.videoId);
        u.searchParams.set('key', key);
        const r = await fetch(u, { signal: AbortSignal.timeout(15000) });
        const item = r.ok ? (await r.json())?.items?.[0] : null;
        out.youtube = item ? {
          found: true, privacy: item.status?.privacyStatus, upload: item.status?.uploadStatus,
          embeddable: item.status?.embeddable, madeForKids: item.status?.madeForKids,
          regionAllowed: item.contentDetails?.regionRestriction?.allowed || null,
          regionBlocked: item.contentDetails?.regionRestriction?.blocked || null,
          contentRating: item.contentDetails?.contentRating || null,
          live: item.snippet?.liveBroadcastContent, duration: item.contentDetails?.duration,
        } : { found: false, http: r.status };
        console.info(TAG, 'youtube says', out);
      }
      // The failed run: full error row and relevant log lines.
      if (c.runId) {
        for (const t of tokens) {
          const r = await fetch('https://api.apify.com/v2/actor-runs/' + c.runId, { headers: { authorization: 'Bearer ' + t }, signal: AbortSignal.timeout(20000) }).catch(() => null);
          if (!r?.ok) continue;
          const run = (await r.json())?.data || {};
          const items = await (await fetch('https://api.apify.com/v2/datasets/' + run.defaultDatasetId + '/items?clean=true&limit=3', { headers: { authorization: 'Bearer ' + t }, signal: AbortSignal.timeout(20000) })).json().catch(() => []);
          for (const it of (Array.isArray(items) ? items : [])) {
            const row = {};
            for (const [k, v] of Object.entries(it)) if (!/url|link/i.test(k)) row[k] = typeof v === 'string' ? redactProviderDiagnostic(v.slice(0, 300), t) : v;
            console.info(TAG, 'failed run row', JSON.stringify(row).slice(0, 1500));
          }
          const log = await (await fetch('https://api.apify.com/v2/logs/' + c.runId + '?stream=false', { headers: { authorization: 'Bearer ' + t }, signal: AbortSignal.timeout(30000) })).text().catch(() => '');
          for (const l of log.split(/\r?\n/).filter(l => /unavailable|country|region|geo|blocked|error|sign in|bot|path|attempt|proxy/i.test(l)).slice(0, 40))
            console.info(TAG, 'failed run log', redactProviderDiagnostic(l.slice(0, 300), t));
          break;
        }
      }
      // Free metadata-only attempt right now.
      const t = tokens[0];
      if (t) {
        const r = await fetch('https://api.apify.com/v2/acts/johnvc~youtube-download-api/run-sync-get-dataset-items?timeout=240&maxTotalChargeUsd=0.01', {
          method: 'POST', headers: { authorization: 'Bearer ' + t, 'content-type': 'application/json' },
          body: JSON.stringify({ videoUrls: ['https://www.youtube.com/watch?v=' + c.videoId], format: 'audio', metadataOnly: true }),
          signal: AbortSignal.timeout(260000),
        });
        const rows = await r.json().catch(() => null);
        for (const it of (Array.isArray(rows) ? rows : [])) {
          const row = {};
          for (const [k, v] of Object.entries(it)) if (!/url|link/i.test(k)) row[k] = typeof v === 'string' ? redactProviderDiagnostic(v.slice(0, 300), t) : v;
          console.info(TAG, 'metadata run now', JSON.stringify(row).slice(0, 1500));
          out.metadataNow = { resultType: it.resultType, error: it.error || it.errorCode || null };
        }
        if (!Array.isArray(rows)) console.info(TAG, 'metadata run http', r.status);
      }
    } catch (e) {
      console.warn(TAG, 'case failed', { videoId: c.videoId, message: String(e?.message || e).slice(0, 200) });
    }
    summary.push(out);
  }
  await p.writeCacheJson(MARKER, { at: new Date().toISOString(), summary }).catch(() => {});
}
