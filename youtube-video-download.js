// "כן לוידאו": the video itself (picture + sound) saved to the top-level
// Yemot folder וידאו, with the YouTube picture as cover and all its details. Nothing is
// played on the phone and no audio copies are made for this request.
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

export function videoQualityFor(durationSec) {
  const m = Number(durationSec) / 60;
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
async function runEngine(actor, videoId, quality, { tokens, log, store, receiptPath, fetchImpl = fetch, sleep = ms => new Promise(r => setTimeout(r, ms)) }) {
  const receipt = await store.read(receiptPath).catch(() => null);
  let runId = receipt?.actor === actor && receipt?.state === 'running' ? receipt.runId : null;
  let ti = Number.isInteger(receipt?.tokenIndex) ? receipt.tokenIndex : 0;
  const api = (t, route, init = {}, ms = 30000) => fetchImpl(API + route, { ...init, headers: { authorization: 'Bearer ' + t, 'content-type': 'application/json' }, signal: AbortSignal.timeout(ms) });
  if (!runId) {
    let started = false;
    for (let i = 0; i < tokens.length && !started; i++) {
      const idx = (ti + i) % tokens.length;
      const r = await api(tokens[idx], '/acts/' + actor + '/runs?timeout=10800&maxTotalChargeUsd=' + (actor === JOHNVC ? '0.05' : '0.2'), { method: 'POST', body: JSON.stringify(inputFor(actor, videoId, quality)) });
      if (ACCOUNT_REFUSAL.has(r.status)) { log.info?.('[VIDEO] account refused start; next key', { videoId, actor, account: idx + 1, status: r.status }); continue; }
      const b = await r.json().catch(() => null);
      if (!r.ok || !b?.data?.id) throw err('video_start_failed', 'Video engine did not start: HTTP ' + r.status);
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
    throw err(classify(item), 'Video engine delivered no file (' + run.status + ')');
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
  if (done?.state === 'done') return { remote: done.remote, already: true };
  const tokens = apifyTokens(env);
  if (!tokens.length) throw err('apify_not_configured', 'No engine keys');
  const facts = await deps.fetchVideoFacts(videoId, env).catch(() => null);
  const durationSec = facts?.durationSeconds || video.durationSeconds || null;
  const quality = videoQualityFor(durationSec);
  const costs = engineCosts(durationSec);
  let order = Object.entries(costs).sort((a, b) => a[1] - b[1]).map(([a]) => a);
  // A run already going (e.g. before a server restart) is continued, never doubled.
  if (done?.state === 'running' && order.includes(done.actor)) order = [done.actor, ...order.filter(a => a !== done.actor)];
  log.info?.('[VIDEO] engine plan', { videoId, durationSec, quality, order, estimatedUsd: costs });
  let got = null, lastErr = null;
  for (const actor of order) {
    try { got = await runEngine(actor, videoId, quality, { tokens, log, store, receiptPath }); break; }
    catch (e) {
      lastErr = e;
      if (e.code === 'youtube_unavailable' || e.code === 'video_pending') throw e; // no engine changes that
      log.warn?.('[VIDEO] engine could not deliver; trying the next one', { videoId, actor, code: e.code, message: String(e.message).slice(0, 160) });
    }
  }
  if (!got) throw lastErr || err('video_engine_failed', 'No engine delivered the video');

  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'video-'));
  try {
    const src = path.join(temp, 'source.mp4'), out = path.join(temp, 'video.mp4');
    const r = await fetch(got.url, { signal: AbortSignal.timeout(2 * 3600 * 1000) });
    if (!r.ok || !r.body) throw err('video_transfer_failed', 'Video file download HTTP ' + r.status);
    await pipeline(Readable.fromWeb(r.body), createWriteStream(src));
    const bytes = (await fs.stat(src)).size;
    const expected = Number(got.item?.fileSizeBytes);
    if (Number.isFinite(expected) && expected > 0 && expected !== bytes) throw err('video_transfer_failed', 'Video file size mismatch');
    if (/^[a-f0-9]{64}$/i.test(got.item?.sha256 || '')) {
      const h = createHash('sha256');
      await new Promise((res, rej) => createReadStream(src).on('data', d => h.update(d)).on('end', res).on('error', rej));
      if (h.digest('hex') !== got.item.sha256.toLowerCase()) throw err('video_transfer_failed', 'Video file checksum mismatch');
    }
    // Picture + all details, streams copied untouched (no quality lost).
    const thumb = await deps.fetchThumbnail(videoId).catch(() => null);
    const jpeg = thumb ? await deps.normalizeCover(thumb.jpeg, { ffmpegPath, maxWidth: 1280, quality: 2 }) : null;
    if (jpeg) await fs.writeFile(path.join(temp, 'cover.jpg'), jpeg);
    const meta = deps.downloadMetadata(videoId, facts || {}, video.title || got.item?.title);
    const dress = async (inFile, outFile, tags) => {
      const args = ['-hide_banner', '-loglevel', 'error', '-y', '-i', inFile];
      if (jpeg) args.push('-i', path.join(temp, 'cover.jpg'));
      args.push('-map', '0:v:0', '-map', '0:a:0?');
      if (jpeg) args.push('-map', '1:v:0', '-disposition:v:1', 'attached_pic');
      args.push('-c', 'copy', '-map_metadata', '-1');
      for (const [k, v] of Object.entries(tags)) args.push('-metadata', k + '=' + String(v));
      args.push('-movflags', '+faststart', outFile);
      try { await ffmpeg(ffmpegPath, args); return outFile; }
      catch (e) { log.warn?.('[VIDEO] picture/details not added; saving the video as delivered', { videoId, message: String(e.message).slice(0, 160) }); return inFile; }
    };
    // One Yemot upload has a size limit (measured on the account); a bigger
    // video is cut (without re-encoding) into numbered complete parts.
    const cap = deps.uploadCap ? await deps.uploadCap() : Infinity;
    const pieces = [];
    if (bytes <= cap * 0.97) pieces.push({ file: await dress(src, path.join(temp, 'video.mp4'), meta), suffix: '' });
    else {
      const dur = Number(durationSec) || Number(got.item?.durationSeconds) || 0;
      const n = Math.ceil(bytes / (cap * 0.8)), seg = Math.max(30, Math.floor(dur / n) || 600);
      await ffmpeg(ffmpegPath, ['-hide_banner', '-loglevel', 'error', '-y', '-i', src, '-map', '0', '-c', 'copy', '-f', 'segment', '-segment_time', String(seg), '-reset_timestamps', '1', '-segment_format', 'mp4', path.join(temp, 'seg%03d.mp4')]);
      const segs = (await fs.readdir(temp)).filter(f => /^seg\d{3}\.mp4$/.test(f)).sort();
      for (const [k, f] of segs.entries()) {
        const tags = { ...meta, title: meta.title + ' (חלק ' + (k + 1) + ' מתוך ' + segs.length + ')', track: (k + 1) + '/' + segs.length };
        pieces.push({ file: await dress(path.join(temp, f), path.join(temp, 'part' + (k + 1) + '.mp4'), tags), suffix: '_חלק_' + (k + 1) });
      }
      log.info?.('[VIDEO] video larger than one upload; cut into parts', { videoId, bytes, cap, parts: pieces.length });
    }
    const name = deps.titleFileName(meta.title || videoId) || videoId;
    const saved = [];
    const t = Date.now();
    for (const pc of pieces) {
      const size = (await fs.stat(pc.file)).size;
      if (size > cap) throw err('video_too_large', 'A video part is still larger than one upload');
      const folder = deps.nextFolder ? await deps.nextFolder() : VIDEO_DIR;
      const remote = folder + '/' + name + pc.suffix + '.mp4';
      await upload(pc.file, remote);
      const m = await getFile(remote);
      if (m?.file?.exists !== true || Number(m?.file?.size) !== size) throw err('video_upload_unverified', 'Video not verified in Yemot');
      await deps.countSaved?.().catch?.(() => {});
      saved.push({ remote, bytes: size });
    }
    const remote = saved[0].remote, size = saved.reduce((a, x) => a + x.bytes, 0);
    await store.write(receiptPath, { videoId, actor: got.actor, runId: got.runId, state: 'done', remote, files: saved, bytes: size, quality, at: new Date().toISOString() });
    log.info?.('[VIDEO] saved', { videoId, files: saved, quality, engine: got.actor, picture: !!jpeg, uploadMs: Date.now() - t });
    return { remote, bytes: size };
  } finally { await fs.rm(temp, { recursive: true, force: true }).catch(() => {}); }
}
