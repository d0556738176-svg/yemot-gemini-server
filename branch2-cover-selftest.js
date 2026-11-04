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
  if (await p.readCacheJson(COVER_RESULT).catch(() => null)) return;
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
