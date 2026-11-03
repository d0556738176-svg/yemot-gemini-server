// One-time diagnostic: print what the johnvc engine writes in its run log and
// status message, so progress can be read from real provider output (never
// estimated). Reads an EXISTING finished run (GET only, no new run, no cost).
// Runs once per probe version; output is redacted (no keys, no URLs).
import { apifyReceiptPath, apifyTokens, tokenFingerprint, redactProviderDiagnostic } from './youtube-apify-source.js';

const TAG = '[BRANCH2_PROVIDER_LOG_PROBE]';
const MARKER = 'ivr2:/2/selftest/provider_log_probe_v1.json';

export async function runProviderLogProbe(env = process.env) {
  if (String(env.BRANCH2_PROVIDER_LOG_PROBE || 'on').toLowerCase() === 'off') return;
  const p = (await import('./youtube-authorized-playback.js'))._pipeline;
  if (await p.readCacheJson(MARKER).catch(() => null)) return;
  const videoId = String(env.BRANCH2_AB_VIDEO || '9scnWAgV6us');
  try {
    const receipt = await p.readCacheJson('ivr2:' + apifyReceiptPath(videoId));
    if (!receipt?.runId) { console.info(TAG, 'no saved run', { videoId }); return; }
    const tokens = apifyTokens(env);
    const token = tokens.find(t => tokenFingerprint(t) === receipt.tokenFp) || tokens[receipt.tokenIndex || 0];
    const get = (route, timeout = 20000) => fetch('https://api.apify.com/v2' + route,
      { headers: { authorization: 'Bearer ' + token }, signal: AbortSignal.timeout(timeout) });
    const run = (await (await get('/actor-runs/' + receipt.runId)).json())?.data || {};
    console.info(TAG, 'run', { actorId: receipt.actorId, status: run.status, statusMessage: redactProviderDiagnostic(run.statusMessage, token),
      startedAt: run.startedAt, finishedAt: run.finishedAt, usageTotalUsd: run.usageTotalUsd ?? null });
    const text = await (await get('/logs/' + receipt.runId + '?stream=false', 30000)).text();
    const lines = text.split(/\r?\n/).filter(Boolean);
    console.info(TAG, 'log size', { lines: lines.length, chars: text.length });
    // Every line that could carry progress, plus the start and end of the log.
    const interesting = lines.filter(l => /%|progress|download|bytes|MB|KiB|MiB|ETA|speed|percent|stage|status|upload|chunk|merg|convert/i.test(l));
    const pick = [...lines.slice(0, 15), '---- progress-like ----', ...interesting.slice(0, 60), '---- end ----', ...lines.slice(-15)];
    for (const l of pick) console.info(TAG, 'line', redactProviderDiagnostic(l.slice(0, 300), token));
    await p.writeCacheJson(MARKER, { at: new Date().toISOString(), runId: receipt.runId, lines: lines.length });
  } catch (e) {
    console.warn(TAG, 'failed', { message: String(e?.message || e).slice(0, 200) });
  }
}
