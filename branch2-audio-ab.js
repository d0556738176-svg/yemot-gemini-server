// Branch 2 listening test: the SAME excerpt prepared the old way (plain
// 8kHz conversion) and the new way (phone mastering), uploaded side by side so
// the owner can compare them on a real phone ("בדיקת איכות" in extension 2).
// Also measures both versions and checks whether Yemot re-encodes an uploaded
// file (download it back and compare bytes). Runs once per mastering version;
// the provider run is reused, so it never starts a new paid download.
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { resolveApifyAudio, NATIVE_ACTOR_ID } from './youtube-apify-source.js';
import { preparePhoneAudio, runFfmpeg, parseIntegratedLufs, PHONE_AUDIO_VERSION } from './youtube-phone-audio.js';
import { titleFileName } from './youtube-audio-cache.js';

const TAG = '[BRANCH2_AUDIO_AB]';
export const AB_OLD_PATH = '/2/selftest/ab_old';
export const AB_NEW_PATH = '/2/selftest/ab_new';
export const AB_MARKER = 'ivr2:/2/selftest/ab_' + PHONE_AUDIO_VERSION + '_t2.json';
const MARKER = AB_MARKER;
// Hebrew file name on purpose: proves Yemot stores and plays Hebrew names.
export const AB_HIFI_PATH = '/2/selftest/דוגמה_איכות_גבוהה';

async function measure(file) {
  const r = await runFfmpeg(['-hide_banner', '-nostats', '-i', file, '-af', 'ebur128=peak=true', '-f', 'null', '-'], { collect: true });
  const peaks = [...r.matchAll(/Peak:\s+(-?[\d.]+|-inf) dBFS/g)];
  const buf = await fs.readFile(file);
  let clipped = 0;
  const start = buf.indexOf('data') + 8;
  for (let i = start; i + 1 < buf.length; i += 2) if (Math.abs(buf.readInt16LE(i)) >= 32600) clipped++;
  return { lufs: parseIntegratedLufs(r), truePeakDb: peaks.length ? Number(peaks[peaks.length - 1][1]) : null, clippedSamples: clipped };
}

export async function runBranch2AudioAB(env = process.env) {
  if (String(env.BRANCH2_AUDIO_AB || 'on').toLowerCase() === 'off') return;
  const p = (await import('./youtube-authorized-playback.js'))._pipeline;
  const force = env.BRANCH2_AB_FORCE === '1';
  if (!force && await p.readCacheJson(MARKER).catch(() => null)) {
    console.info(TAG, 'already prepared for this mastering version', { version: PHONE_AUDIO_VERSION });
    return;
  }
  const videoId = String(env.BRANCH2_AB_VIDEO || '9scnWAgV6us');
  const startSec = Math.max(0, Number(env.BRANCH2_AB_START_SEC) || 300);
  const lenSec = Math.max(20, Math.min(180, Number(env.BRANCH2_AB_SECONDS) || 75));
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'audio-ab-'));
  try {
    const resolved = await resolveApifyAudio(videoId, env, {
      store: { read: p.readCacheJson, write: p.writeCacheJson }, actor: NATIVE_ACTOR_ID });
    const src = path.join(dir, 'source');
    await p.transferProviderFile(resolved, src, undefined, () => {},
      resolved.actorId === NATIVE_ACTOR_ID ? resolved.item.fileSizeBytes : null);
    const excerpt = path.join(dir, 'excerpt.wav');
    await runFfmpeg(['-hide_banner', '-loglevel', 'error', '-y', '-ss', String(startSec), '-t', String(lenSec), '-i', src,
      '-vn', '-c:a', 'pcm_s16le', excerpt]);
    const oldWav = path.join(dir, 'old.wav'), newWav = path.join(dir, 'new.wav');
    // Exactly the previous production conversion.
    await runFfmpeg(['-hide_banner', '-loglevel', 'error', '-y', '-i', excerpt, '-vn', '-ar', '8000', '-ac', '1', '-c:a', 'pcm_s16le', oldWav]);
    const mastered = await preparePhoneAudio(excerpt, newWav, { env });
    const before = { old: await measure(oldWav), new: await measure(newWav) };
    console.info(TAG, 'levels', { videoId, startSec, lenSec, old: before.old, new: before.new, gainDb: mastered.gainDb, soxr: mastered.soxr });

    // CD-quality rendering (44.1kHz, full band, same level control), sent
    // WITHOUT Yemot conversion, to learn what Yemot really keeps and plays.
    const hifiWav = path.join(dir, 'hifi.wav');
    await preparePhoneAudio(excerpt, hifiWav, { env, sampleRate: 44100 });
    // The new phone version, saved under the original YouTube title.
    const titledPath = '/2/selftest/' + titleFileName(resolved.title || videoId);
    const uploads = [[oldWav, AB_OLD_PATH, true], [newWav, AB_NEW_PATH, true], [newWav, titledPath, true], [hifiWav, AB_HIFI_PATH, false]];
    const stored = {};
    for (const [file, target, convertAudio] of uploads) {
      const sent = (await fs.stat(file)).size;
      try {
        const res = await p.uploadToYemot(file, 'ivr2:' + target + '.wav', undefined, { convertAudio });
        const meta = await p.getYemotFile('ivr2:' + target + '.wav');
        const size = Number(meta?.file?.size), dur = Number(meta?.file?.duration);
        stored[target] = { ok: true, size, duration: dur };
        console.info(TAG, 'uploaded', { target, convertAudio, sentBytes: sent, storedBytes: size || null, duration: dur || null,
          // 16000 = 8kHz/16-bit mono (phone); 88200 would mean 44.1kHz kept as sent.
          storedBytesPerSecond: size && dur ? Math.round(size / dur) : null, convertedSize: res?.convertedSize ?? null });
      } catch (e) {
        stored[target] = { ok: false, error: String(e?.message || e).slice(0, 200) };
        console.warn(TAG, 'upload rejected', { target, convertAudio, error: stored[target].error });
      }
    }
    // Does Yemot change what we upload? If the bytes come back identical, the
    // phone plays exactly our mastering with no second conversion.
    const url = new URL(p.YEMOT_API_BASE + '/DownloadFile');
    url.searchParams.set('token', p.yemotApiKey());
    url.searchParams.set('path', 'ivr2:' + AB_NEW_PATH + '.wav');
    const r = await fetch(url, { signal: AbortSignal.timeout(60000) });
    const back = Buffer.from(await r.arrayBuffer());
    const sent = await fs.readFile(newWav);
    const sha = b => createHash('sha256').update(b).digest('hex').slice(0, 16);
    const backFile = path.join(dir, 'back.wav');
    await fs.writeFile(backFile, back);
    const afterYemot = r.ok && back.subarray(0, 4).toString() === 'RIFF' ? await measure(backFile).catch(() => null) : null;
    console.info(TAG, 'yemot round trip', { httpOk: r.ok, sentBytes: sent.length, returnedBytes: back.length,
      identical: sha(sent) === sha(back), returnedHeader: back.subarray(0, 4).toString('latin1'), afterYemot });
    await p.writeCacheJson(MARKER, { version: PHONE_AUDIO_VERSION, videoId, startSec, lenSec, levels: before,
      paths: { old: AB_OLD_PATH, titled: stored[titledPath]?.ok ? titledPath : AB_NEW_PATH, hifi: stored[AB_HIFI_PATH]?.ok ? AB_HIFI_PATH : null },
      stored, createdAt: new Date().toISOString() });
    console.info(TAG, 'ready: call extension 2 and say "בדיקת איכות"');
  } catch (e) {
    console.warn(TAG, 'failed', { code: e?.code || null, message: String(e?.message || e).slice(0, 300) });
  } finally {
    await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}
