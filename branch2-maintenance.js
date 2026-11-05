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

// Over-50MB file (v4): first ONE plain request; if Yemot refuses it, the
// multi-part protocol. Result decides how big files are uploaded.
export async function runBigUploadTest() {
  const p = (await import('./youtube-authorized-playback.js'))._pipeline;
  const MARK2 = 'ivr2:/2/selftest/big_upload_v4.json';
  if (await p.readCacheJson(MARK2).catch(() => null)) return;
  const out = {};
  const ffmpegPath = (await import('ffmpeg-static')).default;
  const tmp = path.join(os.tmpdir(), 'big-' + Date.now() + '.wav');
  try {
    await new Promise((res, rej) => {
      const c = spawn(ffmpegPath, ['-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'sine=f=440:d=3500', '-af', 'volume=-20dB', '-ar', '8000', '-ac', '1', '-c:a', 'pcm_s16le', '-map_metadata', '-1', '-fflags', '+bitexact', tmp]);
      c.on('error', rej); c.on('close', x => x === 0 ? res() : rej(new Error('ffmpeg ' + x)));
    });
    const bytes = (await fs.stat(tmp)).size;
    for (const [label, opts] of [['single', { convertAudio: false, single: true }], ['parts', { convertAudio: false }]]) {
      const r = { bytes };
      const remote = 'ivr2:/2/selftest/big_upload_' + label + '.wav';
      const t = Date.now();
      try {
        await p.uploadToYemot(tmp, remote, undefined, opts);
        const meta = await p.getYemotFile(remote);
        Object.assign(r, { yemotSize: meta?.file?.size ?? null, duration: meta?.file?.duration ?? null, oneFile: Number(meta?.file?.size) === bytes });
      } catch (e) { r.error = String(e?.message || e).slice(0, 200); }
      r.ms = Date.now() - t;
      await fileAction(p, { action: 'delete', what: remote }).catch(() => {});
      out[label] = r;
      if (label === 'single' && r.oneFile) break;
    }
  } catch (e) { out.error = String(e?.message || e).slice(0, 200); }
  await fs.rm(tmp, { force: true }).catch(() => {});
  console.info(TAG, 'big upload v4', JSON.stringify(out));
  await p.writeCacheJson(MARK2, out).catch(() => {});
}

// v2 (04.11 evening): which multi-part request style Yemot accepts, then move
// the download copies from /2 to the top-level folder אודיו and remove the
// earlier /2/וידאו folder.
export async function runMaintenanceV2(env = process.env) {
  const mod = await import('./youtube-authorized-playback.js');
  const p = mod._pipeline;
  const MARK2 = 'ivr2:/2/selftest/maintenance_v6.json';
  if (await p.readCacheJson(MARK2).catch(() => null)) return;
  const report = { at: new Date().toISOString(), tried: [] };
  // leftovers of the earlier attempts (saved as folders)
  for (const d of ['mp_full.wav', 'mp_nopath.wav', 'mp_query.wav']) await fileAction(p, { action: 'delete', what: 'ivr2:/2/selftest/' + d }).catch(() => {});
  // a) multi-part protocol, 24MB file in 8MB parts
  try {
    const ffmpegPath = (await import('ffmpeg-static')).default;
    const tmp = path.join(os.tmpdir(), 'mp-' + Date.now() + '.wav');
    await new Promise((res, rej) => {
      const c = spawn(ffmpegPath, ['-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'sine=f=440:d=1500', '-af', 'volume=-20dB', '-ar', '8000', '-ac', '1', '-c:a', 'pcm_s16le', '-map_metadata', '-1', '-fflags', '+bitexact', tmp]);
      c.on('error', rej); c.on('close', x => x === 0 ? res() : rej(new Error('ffmpeg ' + x)));
    });
    const bytes = (await fs.stat(tmp)).size;
    for (const style of ['full']) {
      const remote = 'ivr2:/2/selftest/mp_' + style + '.wav';
      const r = { style };
      try {
        await p.uploadToYemotInParts(tmp, remote, undefined, { convertAudio: false, style, partBytes: 8 * 1024 * 1024, log: (a, b) => { r[a === 'first part answer' ? 'firstPart' : 'lastPart'] = b; } });
        const meta = await p.getYemotFile(remote);
        r.size = meta?.file?.size ?? null; r.meta = JSON.stringify(meta).slice(0, 300); r.oneFile = Number(r.size) === bytes; r.done = p.lastDoneVariant();
      } catch (e) { r.error = String(e?.message || e).slice(0, 220); }
      await fileAction(p, { action: 'delete', what: remote }).catch(() => {});
      report.tried.push(r);
      console.info(TAG, 'multipart', JSON.stringify(r));
      if (r.oneFile) { report.works = { part: style, done: r.done }; break; }
    }
    await fs.rm(tmp, { force: true }).catch(() => {});
  } catch (e) { report.multipartError = String(e?.message || e).slice(0, 200); }
  await p.writeCacheJson('ivr2:/2/selftest/multipart_v1.json', { at: report.at, works: report.works || null, tried: report.tried }).catch(() => {});

  // b) move download copies /2/*.m4a|*.flac -> /אודיו (once)
  if (!(await p.readCacheJson('ivr2:/2/selftest/maintenance_v2.json').catch(() => null))) try {
    const listing = await listDir(p, 'ivr2:/2');
    const files = (listing?.files || []).map(f => f.name).filter(n => /\.(m4a|flac|mp3)$/i.test(n));
    report.moved = [];
    for (const name of files) {
      const res = await fileAction(p, { action: 'move', what: 'ivr2:/2/' + name, target: 'ivr2:/אודיו/' + name });
      report.moved.push({ name, ok: res.ok });
    }
    const del = await fileAction(p, { action: 'delete', what: 'ivr2:/2/וידאו' });
    report.oldVideoFolderDeleted = del.ok;
    // count what is now in the audio folder
    await p.writeCacheJson('ivr2:/2/youtubeaudio/download_folders.json', { audio: { n: 1, count: report.moved.filter(m => m.ok).length }, video: { n: 1, count: 0 } }).catch(() => {});
  } catch (e) { report.moveError = String(e?.message || e).slice(0, 200); }
  console.info(TAG, 'v2', JSON.stringify(report));
  await p.writeCacheJson(MARK2, report).catch(() => {});
}

// v7: which way of saying "no conversion" keeps a non-audio file (mp4) intact
// through the multi-part join.
export async function runMultipartConvertTest() {
  const p = (await import('./youtube-authorized-playback.js'))._pipeline;
  const MARK = 'ivr2:/2/selftest/multipart_v2.json';
  if (await p.readCacheJson(MARK).catch(() => null)) return;
  const ffmpegPath = (await import('ffmpeg-static')).default;
  const tmp = path.join(os.tmpdir(), 'mpv-' + Date.now() + '.mp4');
  const out = { tried: [] };
  try {
    await new Promise((res, rej) => {
      const c = spawn(ffmpegPath, ['-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc2=s=1280x720:r=25:d=40', '-f', 'lavfi', '-i', 'sine=d=40', '-c:v', 'libx264', '-preset', 'ultrafast', '-qp', '10', '-c:a', 'aac', '-shortest', tmp]);
      c.on('error', rej); c.on('close', x => x === 0 ? res() : rej(new Error('ffmpeg ' + x)));
    });
    const bytes = (await fs.stat(tmp)).size; out.bytes = bytes;
    for (const conv of [null, 'false', '0', 'no']) {
      const remote = 'ivr2:/2/selftest/mpv_test.mp4';
      const r = { conv };
      try {
        await p.uploadToYemotInParts(tmp, remote, undefined, { convertAudio: false, style: 'full', partBytes: Math.ceil(bytes / 3), doneConvert: conv });
        r.ok = true;
      } catch (e) { r.error = String(e?.message || e).slice(0, 200); }
      const m = await p.getYemotFile(remote).catch(() => null);
      r.size = m?.file?.size ?? null; r.intact = Number(r.size) === bytes;
      await fileAction(p, { action: 'delete', what: remote }).catch(() => {});
      out.tried.push(r);
      if (r.intact) { out.works = { part: 'full', done: p.lastDoneVariant(), convert: conv }; break; }
    }
  } catch (e) { out.error = String(e?.message || e).slice(0, 200); }
  await fs.rm(tmp, { force: true }).catch(() => {});
  console.info(TAG, 'multipart convert', JSON.stringify(out));
  await p.writeCacheJson(MARK, out).catch(() => {});
  if (out.works) await p.writeCacheJson('ivr2:/2/selftest/multipart_v1.json', { at: new Date().toISOString(), works: out.works }).catch(() => {});
}

// v8: the real size limit of ONE upload request on this account (non-audio
// files are never converted only on the single-request path).
export async function runUploadCapTest() {
  const p = (await import('./youtube-authorized-playback.js'))._pipeline;
  const MARK = 'ivr2:/2/selftest/upload_cap_v1.json';
  if (await p.readCacheJson(MARK).catch(() => null)) return;
  const out = { tried: [] };
  for (const mb of [60, 64, 70, 75, 80]) {
    const tmp = path.join(os.tmpdir(), 'cap-' + mb + '.mp4');
    const r = { mb };
    try {
      const fh = await fs.open(tmp, 'w');
      const block = Buffer.alloc(1024 * 1024, 7);
      for (let i = 0; i < mb; i++) await fh.write(block);
      await fh.close();
      const remote = 'ivr2:/2/selftest/cap_test.mp4';
      await p.uploadToYemot(tmp, remote, undefined, { convertAudio: false, single: true });
      const m = await p.getYemotFile(remote).catch(() => null);
      r.ok = Number(m?.file?.size) === mb * 1024 * 1024;
      await fileAction(p, { action: 'delete', what: remote }).catch(() => {});
    } catch (e) { r.ok = false; r.error = String(e?.message || e).slice(0, 80); }
    await fs.rm(tmp, { force: true }).catch(() => {});
    out.tried.push(r);
    if (!r.ok) break;
  }
  out.maxOkMb = Math.max(56, ...out.tried.filter(t => t.ok).map(t => t.mb));
  console.info(TAG, 'upload cap', JSON.stringify(out));
  await p.writeCacheJson(MARK, out).catch(() => {});
}

// Files already saved with Hebrew names get their English-letter names (05.11).
export async function runRenameLatin() {
  const p = (await import('./youtube-authorized-playback.js'))._pipeline;
  const MARK = 'ivr2:/2/selftest/rename_latin_v1.json';
  if (await p.readCacheJson(MARK).catch(() => null)) return;
  const { latinTitle, latinFileName } = await import('./youtube-latin-name.js');
  const out = [];
  for (const dir of ['ivr2:/אודיו', 'ivr2:/וידאו']) {
    const listing = await listDir(p, dir);
    for (const f of (listing?.files || [])) {
      const name = String(f.name || '');
      const m = /^(.*)\.(flac|m4a|mp3|mp4)$/i.exec(name);
      if (!m || !/[\u05d0-\u05ea]/.test(name)) continue;
      const latin = latinFileName(await latinTitle(m[1].replace(/_/g, ' ')));
      if (!latin) continue;
      const res = await fileAction(p, { action: 'move', what: dir + '/' + name, target: dir + '/' + latin + '.' + m[2] });
      out.push({ from: name, to: latin + '.' + m[2], ok: res.ok });
    }
  }
  console.info(TAG, 'rename latin', JSON.stringify(out));
  await p.writeCacheJson(MARK, { at: new Date().toISOString(), out }).catch(() => {});
}

// 05.11 evening: the first renaming ran while the language model was not
// reachable, so names were letter-by-letter. Renames again with the working
// model, from the original Hebrew title (first renaming record) or the song's
// YouTube title (owners map -> video id).
export async function runRenameLatinV2() {
  const p = (await import('./youtube-authorized-playback.js'))._pipeline;
  const MARK = 'ivr2:/2/selftest/rename_latin_v2.json';
  if (await p.readCacheJson(MARK).catch(() => null)) return;
  const { latinTitle, latinFileName } = await import('./youtube-latin-name.js');
  const v1 = await p.readCacheJson('ivr2:/2/selftest/rename_latin_v1.json').catch(() => null);
  const hebrewOf = new Map((v1?.out || []).map(x => [String(x.to).replace(/\.[^.]+$/, ''), String(x.from).replace(/\.[^.]+$/, '').replace(/_/g, ' ')]));
  const OWN = 'ivr2:/2/youtubeaudio/download_owners.json';
  const owners = await p.readCacheJson(OWN).catch(() => null) || {};
  const ytTitle = async id => {
    const key = process.env.YOUTUBE_API_KEY; if (!key || !id) return null;
    const r = await fetch('https://www.googleapis.com/youtube/v3/videos?part=snippet&id=' + encodeURIComponent(id) + '&key=' + encodeURIComponent(key)).catch(() => null);
    return (await r?.json().catch(() => null))?.items?.[0]?.snippet?.title || null;
  };
  const out = [];
  const dirs = [];
  for (const base of ['ivr2:/אודיו', 'ivr2:/וידאו']) for (const k of ['', '_2', '_3', '_4']) dirs.push(base + k);
  for (const dir of dirs) {
    const listing = await listDir(p, dir).catch(() => null);
    for (const f of (listing?.files || [])) {
      const name = String(f.name || '');
      const m = /^(.*?)(_Part_\d+)?\.(flac|m4a|mp3|mp4|srt)$/i.exec(name);
      if (!m) continue;
      const stem = m[1];
      const source = hebrewOf.get(stem) || (/[א-ת]/.test(stem) ? stem.replace(/_/g, ' ') : null) || await ytTitle(owners[stem]);
      if (!source || !/[א-ת]/.test(source)) continue;
      const latin = latinFileName(await latinTitle(source));
      if (!latin || latin === stem) continue;
      const target = latin + (m[2] || '') + '.' + m[3];
      const res = await fileAction(p, { action: 'move', what: dir + '/' + name, target: dir + '/' + target });
      if (res.ok && owners[stem] && !owners[latin]) { owners[latin] = owners[stem]; }
      out.push({ dir, from: name, to: target, ok: res.ok });
    }
  }
  await p.writeCacheJson(OWN, owners).catch(() => {});
  console.info(TAG, 'rename latin v2', JSON.stringify(out));
  await p.writeCacheJson(MARK, { at: new Date().toISOString(), out }).catch(() => {});
}
