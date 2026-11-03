// One-time diagnostic: print what the johnvc engine writes in its run log and
// status message, so progress can be read from real provider output (never
// estimated). Reads an EXISTING finished run (GET only, no new run, no cost).
// Runs once per probe version; output is redacted (no keys, no URLs).
import { apifyReceiptPath, apifyTokens, redactProviderDiagnostic } from './youtube-apify-source.js';

const TAG = '[BRANCH2_PROVIDER_LOG_PROBE]';
const MARKER = 'ivr2:/2/selftest/provider_log_probe_v2.json';
// Finished johnvc run of 9scnWAgV6us (02.11 23:26), seen in the service logs.
const KNOWN_RUN_IDS = ['hcHAf0vO6VteJGvGw'];

export async function runProviderLogProbe(env = process.env) {
  if (String(env.BRANCH2_PROVIDER_LOG_PROBE || 'on').toLowerCase() === 'off') return;
  const p = (await import('./youtube-authorized-playback.js'))._pipeline;
  if (await p.readCacheJson(MARKER).catch(() => null)) return;
  const videoId = String(env.BRANCH2_AB_VIDEO || '9scnWAgV6us');
  try {
    const receipt = await p.readCacheJson('ivr2:' + apifyReceiptPath(videoId)).catch(() => null);
    const runIds = [receipt?.runId, ...String(env.BRANCH2_PROBE_RUN_IDS || '').split(','), ...KNOWN_RUN_IDS]
      .map(x => String(x || '').trim()).filter(x => /^[A-Za-z0-9]+$/.test(x));
    const tokens = apifyTokens(env);
    // The run belongs to one of the accounts; find it with GETs only.
    let token = null, runId = null, runData = null;
    for (const id of runIds) {
      for (const t of tokens) {
        const r = await fetch('https://api.apify.com/v2/actor-runs/' + id, { headers: { authorization: 'Bearer ' + t }, signal: AbortSignal.timeout(20000) }).catch(() => null);
        if (r?.ok) { token = t; runId = id; runData = (await r.json())?.data || {}; break; }
      }
      if (runId) break;
    }
    if (!runId) { console.info(TAG, 'no readable run', { tried: runIds.length, keys: tokens.length }); return; }
    const get = (route, timeout = 20000) => fetch('https://api.apify.com/v2' + route,
      { headers: { authorization: 'Bearer ' + token }, signal: AbortSignal.timeout(timeout) });
    const receiptLike = { runId, actorId: runData.actId || null };
    const run = runData;
    console.info(TAG, 'run', { runId, actorId: receiptLike.actorId, account: tokens.indexOf(token) + 1, status: run.status, statusMessage: redactProviderDiagnostic(run.statusMessage, token),
      startedAt: run.startedAt, finishedAt: run.finishedAt, usageTotalUsd: run.usageTotalUsd ?? null });
    const text = await (await get('/logs/' + runId + '?stream=false', 30000)).text();
    const lines = text.split(/\r?\n/).filter(Boolean);
    console.info(TAG, 'log size', { lines: lines.length, chars: text.length });
    // Every line that could carry progress, plus the start and end of the log.
    const interesting = lines.filter(l => /%|progress|download|bytes|MB|KiB|MiB|ETA|speed|percent|stage|status|upload|chunk|merg|convert/i.test(l));
    const pick = [...lines.slice(0, 15), '---- progress-like ----', ...interesting.slice(0, 60), '---- end ----', ...lines.slice(-15)];
    for (const l of pick) console.info(TAG, 'line', redactProviderDiagnostic(l.slice(0, 300), token));
    await p.writeCacheJson(MARKER, { at: new Date().toISOString(), runId, lines: lines.length });
  } catch (e) {
    console.warn(TAG, 'failed', { message: String(e?.message || e).slice(0, 200) });
  }
}
