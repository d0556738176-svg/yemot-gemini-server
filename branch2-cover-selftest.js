// One-time check on the real Yemot account: does a WAV with the YouTube
// picture embedded (id3 chunk after the audio) survive upload unchanged, and
// does Yemot still report the right length? Tried both as stored (convertAudio
// 0) and through Yemot's converter (convertAudio 1, used by extension 7).
// Writes ivr2:/2/selftest/cover_result_v1.json; playback uses the picture only
// when this proved it safe.
import { promises as fs } from 'node:fs';
import { spawn } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { addCoverArt } from './youtube-cover-art.js';

const TAG = '[BRANCH2_COVER_SELFTEST]';
export const COVER_RESULT = 'ivr2:/2/selftest/cover_result_v1.json';

export async function runCoverSelftest(env = process.env) {
  if (String(env.BRANCH2_COVER_ART || 'on').toLowerCase() === 'off') return;
  const p = (await import('./youtube-authorized-playback.js'))._pipeline;
  if (await p.readCacheJson(COVER_RESULT).catch(() => null)) return runDownloadCopySelftest(env);
  const ffmpegPath = (await import('ffmpeg-static')).default;
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'covertest-'));
  try {
    const wav = path.join(dir, 't.wav');
    await new Promise((res, rej) => {
      const c = spawn(ffmpegPath, ['-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'sine=f=440:d=20', '-af', 'volume=-18dB', '-ar', '8000', '-ac', '1', '-c:a', 'pcm_s16le', '-map_metadata', '-1', '-fflags', '+bitexact', wav]);
      c.on('error', rej); c.on('close', x => x === 0 ? res() : rej(new Error('ffmpeg ' + x)));
    });
    const plainBytes = (await fs.stat(wav)).size;
    const ok = await addCoverArt(wav, { videoId: env.BRANCH2_AB_VIDEO || '86eLl-ZYt4A', title: 'בדיקת תמונה', ffmpegPath });
    const local = await fs.readFile(wav);
    const result = { at: new Date().toISOString(), embedded: ok, plainBytes, taggedBytes: local.length, modes: {} };
    for (const convert of [false, true]) {
      const remote = 'ivr2:/2/selftest/cover_c' + (convert ? 1 : 0) + '.wav';
      const m = {};
      try {
        await p.uploadToYemot(wav, remote, undefined, { convertAudio: convert });
        const meta = await p.getYemotFile(remote);
        m.size = meta?.file?.size ?? null; m.duration = meta?.file?.duration ?? null;
        const url = new URL(p.YEMOT_API_BASE + '/DownloadFile');
        url.searchParams.set('token', p.yemotApiKey()); url.searchParams.set('path', remote);
        const back = Buffer.from(await (await fetch(url, { signal: AbortSignal.timeout(30000) })).arrayBuffer());
        m.downloadedBytes = back.length;
        m.identical = Buffer.compare(back, local) === 0;
        m.hasId3 = back.includes(Buffer.from('id3 ', 'latin1')) && back.includes(Buffer.from('APIC', 'latin1'));
        m.durationOk = Number.isFinite(Number(m.duration)) ? Math.abs(Number(m.duration) - 20) <= 1 : null;
      } catch (e) { m.error = String(e?.message || e).slice(0, 200); }
      result.modes[convert ? 'convert' : 'stored'] = m;
    }
    result.safeStored = !!(result.modes.stored?.hasId3 && result.modes.stored?.durationOk !== false);
    result.safeConvert = !!(result.modes.convert?.hasId3 && result.modes.convert?.durationOk !== false);
    console.info(TAG, JSON.stringify(result));
    await p.writeCacheJson(COVER_RESULT, result);
  } catch (e) {
    console.warn(TAG, 'failed', String(e?.message || e).slice(0, 200));
  } finally { await fs.rm(dir, { recursive: true, force: true }).catch(() => {}); }
}

// Second check (the WAV test showed Yemot counts a tag after the audio as
// sound: 20 s became 23 s). Can Yemot keep a downloadable MP3 with the
// picture, byte for byte, outside the played folders?
export const COVER_MP3_RESULT = 'ivr2:/2/selftest/cover_mp3_result_v1.json';
export async function runCoverMp3Selftest(env = process.env) {
  const p = (await import('./youtube-authorized-playback.js'))._pipeline;
  if (await p.readCacheJson(COVER_MP3_RESULT).catch(() => null)) return;
  const ffmpegPath = (await import('ffmpeg-static')).default;
  const { fetchThumbnail, normalizeCover } = await import('./youtube-cover-art.js');
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'covermp3-'));
  try {
    const thumb = await fetchThumbnail(env.BRANCH2_AB_VIDEO || '86eLl-ZYt4A');
    const jpg = path.join(dir, 'c.jpg'), mp3 = path.join(dir, 't.mp3');
    await fs.writeFile(jpg, await normalizeCover(thumb.jpeg, { ffmpegPath }));
    await new Promise((res, rej) => {
      const c = spawn(ffmpegPath, ['-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'sine=f=440:d=20', '-i', jpg, '-map', '0:a', '-map', '1:v',
        '-c:a', 'libmp3lame', '-b:a', '128k', '-c:v', 'copy', '-id3v2_version', '3', '-metadata', 'title=בדיקת תמונה',
        '-metadata:s:v', 'title=Album cover', '-metadata:s:v', 'comment=Cover (front)', '-disposition:v', 'attached_pic', mp3]);
      c.on('error', rej); c.on('close', x => x === 0 ? res() : rej(new Error('ffmpeg ' + x)));
    });
    const local = await fs.readFile(mp3);
    const remote = 'ivr2:/2/selftest/cover_test.mp3';
    const r = { at: new Date().toISOString(), localBytes: local.length };
    try {
      const up = await p.uploadToYemot(mp3, remote, undefined, { convertAudio: false });
      r.upload = { duration: up?.duration ?? null, convertedSize: up?.convertedSize ?? null };
      const meta = await p.getYemotFile(remote);
      r.size = meta?.file?.size ?? null; r.duration = meta?.file?.duration ?? null; r.exists = meta?.file?.exists ?? null;
      const url = new URL(p.YEMOT_API_BASE + '/DownloadFile');
      url.searchParams.set('token', p.yemotApiKey()); url.searchParams.set('path', remote);
      const back = Buffer.from(await (await fetch(url, { signal: AbortSignal.timeout(30000) })).arrayBuffer());
      r.downloadedBytes = back.length; r.identical = Buffer.compare(back, local) === 0;
      r.hasPicture = back.includes(Buffer.from('APIC', 'latin1'));
    } catch (e) { r.error = String(e?.message || e).slice(0, 200); }
    r.safe = r.identical === true && r.hasPicture === true;
    console.info(TAG, 'mp3', JSON.stringify(r));
    await p.writeCacheJson(COVER_MP3_RESULT, r);
  } catch (e) {
    console.warn(TAG, 'mp3 failed', String(e?.message || e).slice(0, 200));
  } finally { await fs.rm(dir, { recursive: true, force: true }).catch(() => {}); }
}

// Downloads folder (04.11, owner's request): create the Hebrew-named folder now
// so it is visible, and pick the best format Yemot keeps byte for byte:
// m4a (YouTube's own audio, untouched) or else mp3 320k.
export async function runDownloadCopySelftest(env = process.env) {
  const p = (await import('./youtube-authorized-playback.js'))._pipeline;
  const { DOWNLOAD_TEST_RESULT } = await import('./youtube-authorized-playback.js');
  if (await p.readCacheJson(DOWNLOAD_TEST_RESULT).catch(() => null)) return;
  const ffmpegPath = (await import('ffmpeg-static')).default;
  const { fetchThumbnail, normalizeCover, makeDownloadCopy, downloadMetadata } = await import('./youtube-cover-art.js');
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'dltest-'));
  const result = { at: new Date().toISOString(), tried: {} };
  try {
    const src = path.join(dir, 'src.m4a');
    await new Promise((res, rej) => {
      const c = spawn(ffmpegPath, ['-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'sine=f=440:d=15', '-ac', '2', '-c:a', 'aac', '-b:a', '128k', src]);
      c.on('error', rej); c.on('close', x => x === 0 ? res() : rej(new Error('ffmpeg ' + x)));
    });
    const vid = env.BRANCH2_AB_VIDEO || '86eLl-ZYt4A';
    const thumb = await fetchThumbnail(vid);
    const jpeg = thumb ? await normalizeCover(thumb.jpeg, { ffmpegPath, maxWidth: 1280, quality: 2 }) : null;
    const metadata = downloadMetadata(vid, { title: 'בדיקת מערכת', channel: 'בדיקה', publishedAt: '2026-11-04T00:00:00Z', description: 'בדיקה', tags: ['בדיקה'], categoryId: '10' });
    for (const format of ['m4a', 'mp3']) {
      const out = path.join(dir, 't.' + format), r = {};
      try {
        r.bytes = await makeDownloadCopy(src, out, { format, jpeg, metadata, ffmpegPath });
        const local = await fs.readFile(out);
        const remote = 'ivr2:/2/selftest/download_test.' + format;
        await p.uploadToYemot(out, remote, undefined, { convertAudio: false });
        const url = new URL(p.YEMOT_API_BASE + '/DownloadFile');
        url.searchParams.set('token', p.yemotApiKey()); url.searchParams.set('path', remote);
        const back = Buffer.from(await (await fetch(url, { signal: AbortSignal.timeout(30000) })).arrayBuffer());
        r.identical = Buffer.compare(back, local) === 0;
      } catch (e) { r.error = String(e?.message || e).slice(0, 200); }
      result.tried[format] = r;
      if (r.identical) { result.format = format; break; }
    }
    console.info(TAG, 'download copy', JSON.stringify(result));
    await p.writeCacheJson(DOWNLOAD_TEST_RESULT, result);
  } catch (e) {
    console.warn(TAG, 'download copy test failed', String(e?.message || e).slice(0, 200));
  } finally { await fs.rm(dir, { recursive: true, force: true }).catch(() => {}); }
}
