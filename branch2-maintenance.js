// One-time maintenance (04.11, owner's requests):
//  1. Move the songs from the old downloads folder to extension 2's own
//     folder, then delete the old folder.
//  2. Prove a file over Yemot's 50MB single-request limit uploads as ONE file
//     (multi-part protocol), then delete the test file.
//  3. Audit every Apify key: valid, plan, this period's usage, what the money
//     was spent on (per engine), and that the cheap engine starts on it
//     (free metadata-only run).
// Nothing secret is logged.
import { promises as fs } from 'node:fs';
import { spawn } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { apifyTokens } from './youtube-apify-source.js';

const TAG = '[BRANCH2_MAINT]';
const MARK = 'ivr2:/2/selftest/maintenance_v1.json';

async function fileAction(p, params) {
  const url = new URL(p.YEMOT_API_BASE + '/FileAction');
  url.searchParams.set('token', p.yemotApiKey());
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  const r = await fetch(url, { signal: AbortSignal.timeout(30000) });
  const body = await r.text();
  let j = null; try { j = JSON.parse(body); } catch { /* not json */ }
  return { ok: r.ok && j?.responseStatus === 'OK' && j?.success !== false, body: body.slice(0, 300) };
}
async function listDir(p, dir) {
  const url = new URL(p.YEMOT_API_BASE + '/GetIVR2Dir');
  url.searchParams.set('token', p.yemotApiKey()); url.searchParams.set('path', dir);
  const j = await (await fetch(url, { signal: AbortSignal.timeout(20000) })).json().catch(() => null);
  return j;
}

export async function runMaintenance(env = process.env) {
  const mod = await import('./youtube-authorized-playback.js');
  const p = mod._pipeline;
  if (await p.readCacheJson(MARK).catch(() => null)) return runBigUploadTest();
  const report = { at: new Date().toISOString() };

  // 1. Old downloads folder -> /2, then delete the folder.
  try {
    const listing = await listDir(p, mod.OLD_DOWNLOAD_DIR);
    const files = (listing?.files || []).map(f => f.name).filter(n => /\.(m4a|mp3)$/i.test(n));
    report.moved = [];
    for (const name of files) {
      const from = mod.OLD_DOWNLOAD_DIR + '/' + name, to = mod.DOWNLOAD_DIR + '/' + name;
      let res = await fileAction(p, { action: 'move', what: from, target: to });
      const meta = await p.getYemotFile(to).catch(() => null);
      if (meta?.file?.exists !== true) {
        // Fallback: copy through the server.
        const url = new URL(p.YEMOT_API_BASE + '/DownloadFile');
        url.searchParams.set('token', p.yemotApiKey()); url.searchParams.set('path', from);
        const tmp = path.join(os.tmpdir(), 'mv-' + Date.now() + path.extname(name));
        await fs.writeFile(tmp, Buffer.from(await (await fetch(url, { signal: AbortSignal.timeout(120000) })).arrayBuffer()));
        await p.uploadToYemot(tmp, to, undefined, { convertAudio: false });
        await fs.rm(tmp, { force: true });
        res = { ok: true, body: 'copied' };
      }
      report.moved.push({ name, how: res.body.slice(0, 60) });
    }
    // Owners list (which video owns which name) now lives with the audio data.
    const owners = await p.readCacheJson(mod.OLD_DOWNLOAD_DIR + '/owners.json').catch(() => null);
    if (owners) await p.writeCacheJson('ivr2:/2/youtubeaudio/download_owners.json', owners).catch(() => {});
    const del = await fileAction(p, { action: 'delete', what: mod.OLD_DOWNLOAD_DIR });
    report.oldFolderDeleted = del.ok; report.deleteAnswer = del.body.slice(0, 120);
  } catch (e) { report.moveError = String(e?.message || e).slice(0, 200); }
  console.info(TAG, 'downloads folder', JSON.stringify(report));

  // 2. Over-50MB file as ONE file.
  try {
    const ffmpegPath = (await import('ffmpeg-static')).default;
    const tmp = path.join(os.tmpdir(), 'big-' + Date.now() + '.wav');
    await new Promise((res, rej) => {
      const c = spawn(ffmpegPath, ['-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'sine=f=440:d=3500', '-af', 'volume=-20dB', '-ar', '8000', '-ac', '1', '-c:a', 'pcm_s16le', '-map_metadata', '-1', '-fflags', '+bitexact', tmp]);
      c.on('error', rej); c.on('close', x => x === 0 ? res() : rej(new Error('ffmpeg ' + x)));
    });
    const bytes = (await fs.stat(tmp)).size;
    const remote = 'ivr2:/2/selftest/big_upload_test.wav';
    const t = Date.now();
    await p.uploadToYemot(tmp, remote, undefined, { convertAudio: false });
    const meta = await p.getYemotFile(remote);
    report.bigUpload = { bytes, yemotSize: meta?.file?.size ?? null, duration: meta?.file?.duration ?? null, ms: Date.now() - t, oneFile: Number(meta?.file?.size) === bytes };
    await fs.rm(tmp, { force: true });
    await fileAction(p, { action: 'delete', what: remote });
  } catch (e) { report.bigUpload = { error: String(e?.message || e).slice(0, 300) }; }
  console.info(TAG, 'big upload', JSON.stringify(report.bigUpload));

  // 3. Apify keys.
  report.accounts = [];
  const actorNames = {};
  for (const [i, t] of apifyTokens(env).entries()) {
    const acc = { key: i + 1 };
    const api = (route, init = {}, ms = 30000) => fetch('https://api.apify.com/v2' + route, { ...init, headers: { authorization: 'Bearer ' + t, 'content-type': 'application/json' }, signal: AbortSignal.timeout(ms) });
    try {
      const me = (await (await api('/users/me')).json())?.data;
      acc.valid = !!me; acc.plan = me?.plan?.id || null;
      const lim = (await (await api('/users/me/limits')).json().catch(() => null))?.data;
      acc.usedUsd = lim?.current?.monthlyUsageUsd ?? null; acc.limitUsd = lim?.limits?.maxMonthlyUsageUsd ?? null;
      acc.cycleStart = lim?.monthlyUsageCycle?.startAt || null;
      const since = Date.parse(acc.cycleStart || '') || (Date.now() - 31 * 864e5);
      const runs = (await (await api('/actor-runs?desc=1&limit=1000')).json().catch(() => null))?.data?.items || [];
      const byActor = {};
      let counted = 0;
      for (const r of runs) {
        if (Date.parse(r.startedAt) < since) continue;
        counted++;
        if (!(r.actId in actorNames)) {
          const a = (await (await api('/acts/' + r.actId)).json().catch(() => null))?.data;
          actorNames[r.actId] = a ? a.username + '/' + a.name : r.actId;
        }
        const n = actorNames[r.actId];
        byActor[n] ||= { runs: 0, usd: 0, ok: 0 };
        byActor[n].runs++; byActor[n].usd += Number(r.usageTotalUsd) || 0; if (r.status === 'SUCCEEDED') byActor[n].ok++;
      }
      for (const v of Object.values(byActor)) v.usd = Math.round(v.usd * 1000) / 1000;
      acc.runsThisPeriod = counted; acc.byEngine = byActor;
      // The cheap engine starts on this key (metadata only: free).
      const r = await api('/acts/johnvc~youtube-download-api/run-sync-get-dataset-items?timeout=180&maxTotalChargeUsd=0.01', { method: 'POST',
        body: JSON.stringify({ videoUrls: ['https://www.youtube.com/watch?v=' + (env.BRANCH2_AB_VIDEO || '86eLl-ZYt4A')], format: 'audio', audioQuality: 'high', metadataOnly: true }) }, 200000);
      const rows = await r.json().catch(() => null);
      acc.cheapEngine = Array.isArray(rows) && rows[0] ? (rows[0].resultType || 'row') + (rows[0].error ? ':' + rows[0].error : '') : 'http ' + r.status;
    } catch (e) { acc.error = String(e?.message || e).slice(0, 160); }
    console.info(TAG, 'account', JSON.stringify(acc));
    report.accounts.push(acc);
  }
  await p.writeCacheJson(MARK, report).catch(() => {});
}

// Re-run of the over-50MB test after the join fix (v2).
export async function runBigUploadTest() {
  const p = (await import('./youtube-authorized-playback.js'))._pipeline;
  const MARK2 = 'ivr2:/2/selftest/big_upload_v3.json';
  if (await p.readCacheJson(MARK2).catch(() => null)) return;
  const r = {};
  try {
    const ffmpegPath = (await import('ffmpeg-static')).default;
    const tmp = path.join(os.tmpdir(), 'big-' + Date.now() + '.wav');
    await new Promise((res, rej) => {
      const c = spawn(ffmpegPath, ['-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'sine=f=440:d=3500', '-af', 'volume=-20dB', '-ar', '8000', '-ac', '1', '-c:a', 'pcm_s16le', '-map_metadata', '-1', '-fflags', '+bitexact', tmp]);
      c.on('error', rej); c.on('close', x => x === 0 ? res() : rej(new Error('ffmpeg ' + x)));
    });
    r.bytes = (await fs.stat(tmp)).size;
    const remote = 'ivr2:/2/selftest/big_upload_test.wav';
    const t = Date.now();
    await p.uploadToYemot(tmp, remote, undefined, { convertAudio: false });
    const meta = await p.getYemotFile(remote);
    Object.assign(r, { yemotSize: meta?.file?.size ?? null, duration: meta?.file?.duration ?? null, ms: Date.now() - t, oneFile: Number(meta?.file?.size) === r.bytes });
    await fs.rm(tmp, { force: true });
    await fileAction(p, { action: 'delete', what: remote });
  } catch (e) { r.error = String(e?.message || e).slice(0, 300); }
  console.info(TAG, 'big upload v3', JSON.stringify(r));
  await p.writeCacheJson(MARK2, r).catch(() => {});
}
