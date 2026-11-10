// "כן לוידאו": the video itself (picture + sound) saved to the top-level
// Yemot folder וידאו, with the YouTube picture as cover and all its details. Nothing is
// played during the call; since 10.11 the same downloaded file also becomes
// the phone audio (see phoneAudioFromFile below), with no second download.
//
// Engine choice, from the engines' own price lists (read 04.11):
//   johnvc  - $0.000011 per video minute at ANY resolution (+$0.00001 start)
//   memo23  - $0.02 start + $0.03 per 720p file (flat)
// johnvc is cheaper for every length (a 12-hour video costs under 1 cent), so
// it always goes first; memo23 is used only if johnvc could not deliver the
// video (blocked/failed), never for a video YouTube marks unavailable.
//
// Quality by length, so the file stays a size Yemot and the free server can
// handle (the price is the same at every resolution): up to 20 minutes 1080p,
// up to 90 minutes 720p, longer 480p. Always H.264, which every computer and
// phone plays.
import { promises as fs, createWriteStream, createReadStream } from 'node:fs';
import { pipeline } from 'node:stream/promises';
import { Readable } from 'node:stream';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { apifyTokens } from './youtube-apify-source.js';

export const VIDEO_DIR = 'ivr2:/וידאו'; // folder chosen per save by download-folders.js
const API = 'https://api.apify.com/v2';
const JOHNVC = 'johnvc~youtube-download-api';
const MEMO23 = 'memo23~youtube-video-downloader';
const ACCOUNT_REFUSAL = new Set([401, 402, 403, 429]);

export function videoQualityFor(durationSec, { subtitles = false } = {}) {
  const m = Number(durationSec) / 60;
  // With Hebrew lines drawn into the picture the server re-encodes the whole
  // video (0.15 CPU on the free plan): a smaller picture is several times
  // faster, so long videos finish in reasonable time (owner, 07.11).
  if (subtitles) {
    if (!Number.isFinite(m) || m <= 0) return '480p';
    if (m <= 15) return '720p';
    if (m <= 60) return '480p';
    return '360p';
  }
  if (!Number.isFinite(m) || m <= 0) return '720p';
  if (m <= 20) return '1080p';
  if (m <= 90) return '720p';
  return '480p';
}
// Estimated cost in USD of each engine for this video (from the price lists).
export function engineCosts(durationSec) {
  const minutes = Math.max(1, Math.ceil((Number(durationSec) || 0) / 60));
  return { [JOHNVC]: minutes * 0.000011 + 0.00002, [MEMO23]: 0.05 };
}
export function videoReceiptPath(videoId) {
  return 'ivr2:/2/youtubejobs/' + Buffer.from(videoId).toString('hex') + '/video.json';
}

function err(code, message) { return Object.assign(new Error(message), { code }); }

function inputFor(actor, videoId, quality) {
  const watch = 'https://www.youtube.com/watch?v=' + videoId;
  if (actor === JOHNVC) return { videoUrls: [watch], format: 'video', quality, videoCodec: 'h264', storageProvider: 'apify', metadataOnly: false, maxMinutes: 720 };
  return { videoUrls: [watch], format: 'mp4', quality, downloadSubtitles: false, maxConcurrency: 1, perVideoTimeoutSecs: 300 };
}

function fileUrlOf(item) {
  for (const [k, v] of Object.entries(item || {})) {
    if (typeof v !== 'string' || !/^https:\/\//.test(v) || !/url|link/i.test(k)) continue;
    if (/thumbnail|subtitle|transcript|channel/i.test(k)) continue;
    const host = new URL(v).hostname;
    if (/(^|\.)youtube\.com$|(^|\.)youtu\.be$|ytimg\.com$/.test(host)) continue;
    return v;
  }
  return null;
}

function classify(item) {
  const text = [item?.error, item?.errorMessage, item?.note].map(v => String(v || '')).join(' ').toLowerCase();
  if (/private|unavailable|removed|deleted|members|age|copyright|country|geo/.test(text)) return 'youtube_unavailable';
  return 'video_engine_failed';
}

// Runs one engine to the end; returns { url, item, token, actor, runId }.
async function runEngine(actor, videoId, quality, { tokens, log, store, receiptPath, startAt = null, fetchImpl = fetch, sleep = ms => new Promise(r => setTimeout(r, ms)) }) {
  const receipt = await store.read(receiptPath).catch(() => null);
  let runId = receipt?.actor === actor && receipt?.state === 'running' ? receipt.runId : null;
  let ti = runId && Number.isInteger(receipt?.tokenIndex) ? receipt.tokenIndex : (Number.isInteger(startAt) ? startAt % tokens.length : 0);
  const api = (t, route, init = {}, ms = 30000) => fetchImpl(API + route, { ...init, headers: { authorization: 'Bearer ' + t, 'content-type': 'application/json' }, signal: AbortSignal.timeout(ms) });
  if (!runId) {
    let started = false;
    for (let i = 0; i < tokens.length && !started; i++) {
      const idx = (ti + i) % tokens.length;
      const r = await api(tokens[idx], '/acts/' + actor + '/runs?timeout=10800&maxTotalChargeUsd=' + (actor === JOHNVC ? '0.05' : '0.2'), { method: 'POST', body: JSON.stringify(inputFor(actor, videoId, quality)) });
      if (ACCOUNT_REFUSAL.has(r.status)) { log.info?.('[VIDEO] account refused start; next key', { videoId, actor, account: idx + 1, status: r.status }); continue; }
      const b = await r.json().catch(() => null);
      // Any other "no" also created no run: the next backup key gets the job.
      if (!r.ok || !b?.data?.id) { log.warn?.('[VIDEO] start failed on this key; next key', { videoId, actor, account: idx + 1, status: r.status, reason: String(b?.error?.message || '').slice(0, 120) }); continue; }
      runId = b.data.id; ti = idx; started = true;
    }
    if (!started) throw err('apify_accounts_unavailable', 'No account could start the video engine');
    await store.write(receiptPath, { videoId, actor, runId, tokenIndex: ti, quality, state: 'running', at: new Date().toISOString() });
    log.info?.('[VIDEO] engine run started', { videoId, actor, runId, account: ti + 1, quality });
  }
  const token = tokens[ti];
  const until = Date.now() + 3 * 3600 * 1000;
  let run = null;
  while (Date.now() < until) {
    run = (await (await api(token, '/actor-runs/' + runId)).json().catch(() => null))?.data;
    if (run && /SUCCEEDED|FAILED|ABORTED|TIMED-OUT/.test(run.status)) break;
    await sleep(10000);
  }
  if (!run || !/SUCCEEDED|FAILED|ABORTED|TIMED-OUT/.test(run.status)) throw err('video_pending', 'Video engine still working');
  const items = await (await api(token, '/datasets/' + run.defaultDatasetId + '/items?clean=true&limit=5')).json().catch(() => []);
  const item = (Array.isArray(items) ? items : []).find(x => String(x?.videoId || videoId) === videoId) || (Array.isArray(items) ? items[0] : null);
  const url = fileUrlOf(item);
  if (!url || item?.error || (item?.resultType && item.resultType !== 'file')) {
    await store.write(receiptPath, { videoId, actor, runId, tokenIndex: ti, state: 'failed', at: new Date().toISOString() }).catch(() => {});
    const e = err(classify(item), 'Video engine delivered no file (' + run.status + ')');
    e.tokenIndex = ti;
    throw e;
  }
  const u = new URL(url);
  if (u.hostname === 'api.apify.com' && !u.searchParams.has('token') && !u.searchParams.has('signature')) u.searchParams.set('token', token);
  return { url: u.toString(), item, actor, runId };
}

function ffmpeg(ffmpegPath, args) {
  return new Promise((resolve, reject) => {
    const p = spawn(ffmpegPath, args, { stdio: ['ignore', 'ignore', 'pipe'] });
    let e = ''; p.stderr.on('data', d => { e = (e + d).slice(-400); });
    const t = setTimeout(() => p.kill('SIGKILL'), 3 * 3600 * 1000);
    p.on('error', reject);
    p.on('close', c => { clearTimeout(t); c === 0 ? resolve() : reject(new Error('ffmpeg failed (' + c + '): ' + e.trim())); });
  });
}

// The whole job. deps: store {read,write}, upload(file, remote), getFile(remote),
// ffmpegPath, fetchThumbnail, normalizeCover, downloadMetadata, fetchVideoFacts,
// titleFileName, log.
export async function downloadVideoToYemot(video, deps, env = process.env) {
  const { store, upload, getFile, ffmpegPath, log = console } = deps;
  const videoId = String(video?.videoId || '');
  if (!/^[A-Za-z0-9_-]{11}$/.test(videoId)) throw err('invalid_video', 'Invalid video id');
  const receiptPath = videoReceiptPath(videoId);
  const done = await store.read(receiptPath).catch(() => null);
  // video.subtitles: true = Hebrew lines in the picture, false = none (the
  // caller's answer); undefined (old jobs) = as before (subtitles on).
  const wantSubs = video.subtitles !== false;
  if (done?.state === 'done') {
    const hadSubs = /hebrew/.test(String(done.subtitles || ''));
    if (!(video.subtitles === true && !hadSubs)) return { remote: done.remote, already: true };
    // Saved before without subtitles and now asked with them: made again.
    for (const f of done.files || []) await deps.deleteFile?.(f.remote).catch?.(() => {});
    log.info?.('[VIDEO] saved earlier without subtitles; making it again with Hebrew subtitles', { videoId, removed: (done.files || []).length });
  }
  const tokens = apifyTokens(env);
  if (!tokens.length) throw err('apify_not_configured', 'No engine keys');
  const { retrying, coverFor } = await import('./youtube-cover-art.js');
  const facts = await retrying(() => deps.fetchVideoFacts(videoId, env), { ok: x => !!(x && x.title) });
  const durationSec = facts?.durationSeconds || video.durationSeconds || null;
  const quality = videoQualityFor(durationSec, { subtitles: wantSubs && !!deps.burnSubtitles });
  const costs = engineCosts(durationSec);
  let order = Object.entries(costs).sort((a, b) => a[1] - b[1]).map(([a]) => a);
  // A run already going (e.g. before a server restart) is continued, never doubled.
  if (done?.state === 'running' && order.includes(done.actor)) order = [done.actor, ...order.filter(a => a !== done.actor)];
  log.info?.('[VIDEO] engine plan', { videoId, durationSec, quality, order, estimatedUsd: costs });
  let got = null, lastErr = null;
  // Each engine is tried on every backup key in turn (a run that failed on one
  // account, e.g. credit ran out mid-run, is started again on the next).
  for (const actor of order) {
    let startAt = null;
    for (let attempt = 0; attempt < tokens.length && !got; attempt++) {
      try { got = await runEngine(actor, videoId, quality, { tokens, log, store, receiptPath, startAt }); }
      catch (e) {
        lastErr = e;
        if (e.code === 'youtube_unavailable' || e.code === 'video_pending') throw e; // no engine or key changes that
        if (!Number.isInteger(e.tokenIndex)) { log.warn?.('[VIDEO] no key could start this engine; trying the next engine', { videoId, actor, code: e.code }); break; }
        startAt = e.tokenIndex + 1;
        log.warn?.('[VIDEO] run failed on this key; trying the next key', { videoId, actor, account: e.tokenIndex + 1, next: (startAt % tokens.length) + 1, message: String(e.message).slice(0, 160) });
      }
    }
    if (got) break;
    log.warn?.('[VIDEO] engine could not deliver; trying the next one', { videoId, actor });
  }
  if (!got) throw lastErr || err('video_engine_failed', 'No engine delivered the video');

  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'video-'));
  try {
    const src = path.join(temp, 'source.mp4'), out = path.join(temp, 'video.mp4');
    // The finished file is fetched up to 3 times (a dropped connection is not a failed video).
    for (let k = 1; ; k++) {
      try {
        const r = await fetch(got.url, { signal: AbortSignal.timeout(2 * 3600 * 1000) });
        if (!r.ok || !r.body) throw err('video_transfer_failed', 'Video file download HTTP ' + r.status);
        await pipeline(Readable.fromWeb(r.body), createWriteStream(src));
        break;
      } catch (e) {
        if (k >= 3) throw e;
        log.warn?.('[VIDEO] file transfer interrupted; fetching again', { videoId, attempt: k, message: String(e?.message || e).slice(0, 120) });
        await new Promise(x => setTimeout(x, 10000 * k));
      }
    }
    const bytes = (await fs.stat(src)).size;
    const expected = Number(got.item?.fileSizeBytes);
    if (Number.isFinite(expected) && expected > 0 && expected !== bytes) throw err('video_transfer_failed', 'Video file size mismatch');
    if (/^[a-f0-9]{64}$/i.test(got.item?.sha256 || '')) {
      const h = createHash('sha256');
      await new Promise((res, rej) => createReadStream(src).on('data', d => h.update(d)).on('end', res).on('error', rej));
      if (h.digest('hex') !== got.item.sha256.toLowerCase()) throw err('video_transfer_failed', 'Video file checksum mismatch');
    }
    // Owner, 10.11: the same download also becomes the phone audio (played in
    // extension 2, listed in 7, FLAC copy in אודיו), so nothing is paid twice.
    // Only the sound track is kept (copied as is; re-encoded losslessly if the
    // container refuses), so the disk never holds the whole video twice.
    if (deps.phoneAudioFromFile) {
      const base = path.join(os.tmpdir(), 'video-audio-' + videoId + '-' + Date.now());
      let copy = base + '.m4a';
      try {
        try { await ffmpeg(ffmpegPath, ['-hide_banner', '-loglevel', 'error', '-y', '-i', src, '-vn', '-map', '0:a:0', '-c:a', 'copy', copy]); }
        catch { await fs.rm(copy, { force: true }).catch(() => {}); copy = base + '.flac'; await ffmpeg(ffmpegPath, ['-hide_banner', '-loglevel', 'error', '-y', '-i', src, '-vn', '-map', '0:a:0', '-c:a', 'flac', copy]); }
        const file = copy;
        void Promise.resolve().then(() => deps.phoneAudioFromFile(file, { title: facts?.title || video.title || got.item?.title }))
          .then(r => log.info?.('[VIDEO] phone audio ready from the same download', { videoId, files: r?.playbackPaths?.length || 0, already: !!r?.already }))
          .catch(e => log.warn?.('[VIDEO] phone audio from the video not made', { videoId, message: String(e?.message || e).slice(0, 160) }))
          .finally(() => fs.rm(file, { force: true }).catch(() => {}));
      } catch (e) { log.warn?.('[VIDEO] sound track not taken for phone audio', { videoId, message: String(e?.message || e).slice(0, 120) }); await fs.rm(copy, { force: true }).catch(() => {}); }
    }
    // Hebrew subtitles when the speech is not Hebrew: embedded as the default
    // subtitle track (streams copied, nothing re-encoded) before any cutting.
    let srcFile = src, subs = null;
    if (wantSubs && deps.hebrewSubtitles) {
      subs = await deps.hebrewSubtitles(src, temp).catch(() => null);
      if (subs?.srt) {
        const srt = path.join(temp, 'he.srt'), withSubs = path.join(temp, 'with_subs.mp4');
        await fs.writeFile(srt, subs.srt);
        // First choice: the lines drawn into the picture (shown by every player).
        const burned = deps.burnSubtitles ? await deps.burnSubtitles(src, subs.srt, temp, { quality, durationSec }).catch(() => null) : null;
        if (burned) { srcFile = burned; subs = { ...subs, burned: true }; }
        else try {
          await ffmpeg(ffmpegPath, ['-hide_banner', '-loglevel', 'error', '-y', '-i', src, '-i', srt, '-map', '0:v:0', '-map', '0:a:0?', '-map', '1:0', '-c', 'copy', '-c:s', 'mov_text', '-metadata:s:s:0', 'language=heb', '-metadata:s:s:0', 'title=עברית', '-disposition:s:0', 'default', withSubs]);
          srcFile = withSubs;
        } catch (e) { log.warn?.('[VIDEO] subtitles not embedded', { videoId, message: String(e.message).slice(0, 160) }); subs = { ...subs, embedded: false }; }
      }
    }
    // Picture + all details, streams copied untouched (no quality lost).
    const jpeg = await coverFor(videoId, { ffmpegPath, maxWidth: 1280, quality: 2, fetchThumbnailImpl: deps.fetchThumbnail, normalize: deps.normalizeCover });
    if (!jpeg || !facts?.title) log.warn?.('[VIDEO] saved with less than full details', { videoId, picture: !!jpeg, details: !!facts?.title });
    if (jpeg) await fs.writeFile(path.join(temp, 'cover.jpg'), jpeg);
    const meta = deps.downloadMetadata(videoId, facts || {}, video.title || got.item?.title);
    const dress = async (inFile, outFile, tags) => {
      const args = ['-hide_banner', '-loglevel', 'error', '-y', '-i', inFile];
      if (jpeg) args.push('-i', path.join(temp, 'cover.jpg'));
      args.push('-map', '0:v:0', '-map', '0:a:0?');
      if (jpeg) args.push('-map', '1:v:0', '-disposition:v:1', 'attached_pic');
      args.push('-map', '0:s?', '-c', 'copy', '-map_metadata', '-1');
      if (srcFile !== src && !subs?.burned) args.push('-metadata:s:s:0', 'language=heb', '-metadata:s:s:0', 'title=עברית', '-disposition:s:0', 'default');
      for (const [k, v] of Object.entries(tags)) args.push('-metadata', k + '=' + String(v));
      args.push('-movflags', '+faststart', outFile);
      try { await ffmpeg(ffmpegPath, args); return outFile; }
      catch (e) { log.warn?.('[VIDEO] picture/details not added; saving the video as delivered', { videoId, message: String(e.message).slice(0, 160) }); return inFile; }
    };
    // One Yemot upload has a size limit (measured on the account); a bigger
    // video is cut (without re-encoding) into numbered complete parts.
    const cap = deps.uploadCap ? await deps.uploadCap() : Infinity;
    const pieces = [];
    const fullBytes = (await fs.stat(srcFile)).size;
    if (fullBytes <= cap * 0.97) pieces.push({ file: await dress(srcFile, path.join(temp, 'video.mp4'), meta), suffix: '' });
    else {
      const dur = Number(durationSec) || Number(got.item?.durationSeconds) || 0;
      const n = Math.ceil(fullBytes / (cap * 0.8)), seg = Math.max(30, Math.floor(dur / n) || 600);
      await ffmpeg(ffmpegPath, ['-hide_banner', '-loglevel', 'error', '-y', '-i', srcFile, '-map', '0', '-c', 'copy', '-f', 'segment', '-segment_time', String(seg), '-reset_timestamps', '1', '-segment_format', 'mp4', path.join(temp, 'seg%03d.mp4')]);
      const segs = (await fs.readdir(temp)).filter(f => /^seg\d{3}\.mp4$/.test(f)).sort();
      for (const [k, f] of segs.entries()) {
        const tags = { ...meta, title: meta.title + ' (חלק ' + (k + 1) + ' מתוך ' + segs.length + ')', track: (k + 1) + '/' + segs.length };
        pieces.push({ file: await dress(path.join(temp, f), path.join(temp, 'part' + (k + 1) + '.mp4'), tags), suffix: '', part: k + 1 });
      }
      log.info?.('[VIDEO] video larger than one upload; cut into parts', { videoId, bytes, cap, parts: pieces.length });
    }
    // Full Hebrew name as seen in Yemot (owner, 06.11); the download page
    // (/downloads) serves it under the same Hebrew name.
    const { titleFileName } = await import('./youtube-audio-cache.js');
    const { yemotFileName } = await import('./youtube-latin-name.js');
    const name = await yemotFileName(meta.title || videoId, { env, titleFileName }) || videoId;
    const saved = [];
    const t = Date.now();
    for (const pc of pieces) {
      const size = (await fs.stat(pc.file)).size;
      if (size > cap) throw err('video_too_large', 'A video part is still larger than one upload');
      const folder = deps.nextFolder ? await deps.nextFolder() : VIDEO_DIR;
      const { withPart } = await import('./youtube-latin-name.js');
      const remote = folder + '/' + (pc.part ? withPart(name, pc.part) : name) + pc.suffix + '.mp4';
      await upload(pc.file, remote);
      const m = await getFile(remote);
      if (m?.file?.exists !== true || Number(m?.file?.size) !== size) throw err('video_upload_unverified', 'Video not verified in Yemot');
      await deps.countSaved?.().catch?.(() => {});
      saved.push({ remote, bytes: size });
    }
    // A separate .srt with the same name, for players that read side files.
    if (subs?.srt && !subs.burned && pieces.length === 1) {
      const srtRemote = saved[0].remote.replace(/\.mp4$/, '.srt');
      try {
        const f = path.join(temp, 'he.srt');
        await upload(f, srtRemote);
        const m = await getFile(srtRemote);
        if (m?.file?.exists === true) { await deps.countSaved?.().catch?.(() => {}); saved.push({ remote: srtRemote, bytes: Number(m.file.size) || 0, subtitles: true }); }
      } catch (e) { log.warn?.('[VIDEO] subtitle file not uploaded (embedded track still in the video)', { message: String(e.message).slice(0, 160) }); }
    }
    const remote = saved[0].remote, size = saved.reduce((a, x) => a + x.bytes, 0);
    await store.write(receiptPath, { videoId, actor: got.actor, runId: got.runId, state: 'done', remote, files: saved, bytes: size, quality, subtitles: subs?.srt ? (subs.burned ? 'hebrew_in_picture' : 'hebrew_track') : (wantSubs ? (subs?.skipped || 'none') : 'not_requested'), at: new Date().toISOString() });
    log.info?.('[VIDEO] saved', { videoId, files: saved, quality, engine: got.actor, picture: !!jpeg, subtitles: subs?.srt ? (subs.burned ? 'hebrew_in_picture' : subs.embedded === false ? 'file_only' : 'hebrew_track') : (wantSubs ? (subs?.skipped || 'none') : 'not_requested'), uploadMs: Date.now() - t });
    return { remote, bytes: size };
  } finally { await fs.rm(temp, { recursive: true, force: true }).catch(() => {}); }
}
export { runEngine as _runEngine };
