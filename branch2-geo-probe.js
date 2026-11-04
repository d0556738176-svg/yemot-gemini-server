// One-time trial (04.11): can a video limited to Israel be downloaded through
// an Israeli residential address, and what does it cost? Tries two engines on
// one IL-only video, each with a hard cost cap. Logs price lists, the result
// row (no URLs), and the real run cost. Keys are never logged.
import { apifyTokens, redactProviderDiagnostic } from './youtube-apify-source.js';

const TAG = '[BRANCH2_GEO_PROBE]';
const MARKER = 'ivr2:/2/selftest/geo_probe_v2.json';
const VIDEO = '7De3QZfnUao'; // allowed only in IL/PS (verified via YouTube API)
const IL = { useApifyProxy: true, apifyProxyGroups: ['RESIDENTIAL'], apifyProxyCountry: 'IL' };
// memo23 ignores Apify proxy settings but accepts our own proxy URLs; the
// account's Apify residential proxy pinned to Israel is such a URL.
const CANDIDATES = [
  { actor: 'memo23~youtube-video-downloader', input: (w, proxyUrl) => ({ urls: [w], videoUrls: [w], format: 'mp3', proxy: { proxyUrls: [proxyUrl] } }) },
];

const clean = (o, t) => {
  // (proxy password is never logged: rows are filtered of url/link/token keys)
  const row = {};
  for (const [k, v] of Object.entries(o || {})) if (!/url|link|token/i.test(k)) row[k] = typeof v === 'string' ? redactProviderDiagnostic(v.slice(0, 300), t) : v;
  return JSON.stringify(row).slice(0, 1500);
};

export async function runGeoProbe(env = process.env) {
  if (String(env.BRANCH2_GEO_PROBE || 'on').toLowerCase() === 'off') return;
  const p = (await import('./youtube-authorized-playback.js'))._pipeline;
  if (await p.readCacheJson(MARKER).catch(() => null)) return;
  await p.writeCacheJson(MARKER, { at: new Date().toISOString(), started: true }).catch(() => {});
  const t = apifyTokens(env)[0];
  if (!t) return;
  const api = (route, init = {}, timeout = 30000) => fetch('https://api.apify.com/v2' + route,
    { ...init, headers: { authorization: 'Bearer ' + t, 'content-type': 'application/json', ...(init.headers || {}) }, signal: AbortSignal.timeout(timeout) });
  const watch = 'https://www.youtube.com/watch?v=' + VIDEO;
  const me = (await (await api('/users/me')).json().catch(() => null))?.data || {};
  const pw = me.proxy?.password;
  console.info(TAG, 'account', { plan: me.plan?.id || null, proxyPassword: !!pw, groups: (me.proxy?.groups || []).map(g => g.name + ':' + (g.availableCount ?? '')).slice(0, 10) });
  if (!pw) return;
  const proxyUrl = 'http://groups-RESIDENTIAL,country-IL:' + pw + '@proxy.apify.com:8000';
  const summary = [];
  for (const c of CANDIDATES) {
    try {
      const a = (await (await api('/acts/' + c.actor)).json())?.data || {};
      const pr = (a.pricingInfos || []).slice(-1)[0] || null;
      console.info(TAG, 'price list', c.actor, JSON.stringify(pr).slice(0, 1200));
      const r = await api('/acts/' + c.actor + '/runs?waitForFinish=240&timeout=900&maxTotalChargeUsd=0.6', { method: 'POST', body: JSON.stringify(c.input(watch, proxyUrl)) }, 260000);
      let run = (await r.json().catch(() => null))?.data;
      if (!run?.id) { console.info(TAG, 'start refused', c.actor, r.status); summary.push({ actor: c.actor, refused: r.status }); continue; }
      for (let i = 0; i < 40 && !/SUCCEEDED|FAILED|ABORTED|TIMED-OUT/.test(run.status); i++) {
        await new Promise(res => setTimeout(res, 15000));
        run = (await (await api('/actor-runs/' + run.id)).json())?.data || run;
      }
      await new Promise(res => setTimeout(res, 10000));
      run = (await (await api('/actor-runs/' + run.id)).json())?.data || run;
      const items = await (await api('/datasets/' + run.defaultDatasetId + '/items?clean=true&limit=3')).json().catch(() => []);
      for (const it of (Array.isArray(items) ? items : [])) console.info(TAG, 'row', c.actor, clean(it, t).split(pw).join('***'));
      const log = await (await api('/logs/' + run.id + '?stream=false', {}, 30000)).text().catch(() => '');
      for (const l of log.split(/\r?\n/).filter(l => /unavailable|country|region|geo|proxy|error|fail|download|done|finish|size|MB/i.test(l)).slice(-25))
        console.info(TAG, 'log', c.actor, redactProviderDiagnostic(l.split(pw).join('***').replace(/proxy\.apify\.com\S*/g,'[proxy]').slice(0, 250), t));
      const info = { actor: c.actor, status: run.status, secs: run.stats?.runTimeSecs, usd: run.usageTotalUsd, charged: run.chargedEventCounts || null, usage: run.usageUsd ? Object.fromEntries(Object.entries(run.usageUsd).filter(([, v]) => v > 0)) : null };
      console.info(TAG, 'result', JSON.stringify(info));
      summary.push(info);
    } catch (e) {
      console.warn(TAG, 'candidate failed', c.actor, String(e?.message || e).slice(0, 200));
    }
  }
  await p.writeCacheJson(MARKER, { at: new Date().toISOString(), summary }).catch(() => {});
}
