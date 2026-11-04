// One-time read (GET only, free): price lists of the two engines and the
// input fields memo23 accepts, to plan "yes to video" from real numbers.
import { apifyTokens } from './youtube-apify-source.js';
const TAG = '[BRANCH2_VIDEO_PROBE]';
export async function runVideoProbe(env = process.env) {
  const p = (await import('./youtube-authorized-playback.js'))._pipeline;
  const MARK = 'ivr2:/2/selftest/video_probe_v1.json';
  if (await p.readCacheJson(MARK).catch(() => null)) return;
  const t = apifyTokens(env)[0]; if (!t) return;
  const api = r => fetch('https://api.apify.com/v2' + r, { headers: { authorization: 'Bearer ' + t }, signal: AbortSignal.timeout(30000) }).then(x => x.json()).catch(() => null);
  for (const actor of ['johnvc~youtube-download-api', 'memo23~youtube-video-downloader']) {
    const a = (await api('/acts/' + actor))?.data;
    const pr = (a?.pricingInfos || []).slice(-1)[0];
    const ev = pr?.pricingPerEvent?.actorChargeEvents || {};
    for (const [k, v] of Object.entries(ev)) console.info(TAG, actor, 'event', k, JSON.stringify({ title: v.eventTitle, desc: String(v.eventDescription || '').slice(0, 160), usd: v.eventPriceUsd ?? v.eventTieredPricingUsd?.FREE?.tieredEventPriceUsd }));
    const b = (await api('/acts/' + actor + '/builds/default'))?.data;
    let schema = b?.inputSchema || b?.actorDefinition?.input; if (typeof schema === 'string') { try { schema = JSON.parse(schema); } catch { schema = null; } }
    for (const [k, v] of Object.entries(schema?.properties || {})) console.info(TAG, actor, 'input', k, JSON.stringify({ type: v.type, def: v.default, enum: v.enum, desc: String(v.description || '').slice(0, 200) }));
    // dataset fields of a past successful run (no URLs)
  }
  await p.writeCacheJson(MARK, { at: new Date().toISOString() }).catch(() => {});
}
