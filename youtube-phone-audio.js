// Branch 2 telephone audio mastering.
//
// Yemot stores and plays audio as 8kHz / 16-bit / mono (measured: 16000 bytes
// per second on the real account), so the phone line, not YouTube, is the
// quality ceiling. What decides how a song SOUNDS on the phone is how it is
// prepared for that line. A plain "-ar 8000 -ac 1" conversion keeps modern
// loud masters at 0 dBFS (harsh and distorted on a handset) and leaves quiet
// uploads 30-40 dB quieter than loud ones.
//
// This module prepares one complete phone-ready WAV in two cheap passes:
//   1. decode -> mono -> remove inaudible-on-phone bass (<140Hz, which only
//      eats headroom) and the harsh band near the 4kHz line limit -> slight
//      presence lift for clarity -> high-quality resample to 8kHz, with 6dB of
//      headroom so nothing clips while being processed.
//   2. measure the whole song's real loudness (EBU R128) on that small 8kHz
//      file, then apply ONE fixed gain to a moderate phone level, a gentle
//      compressor and a hard ceiling well below full scale, with dither.
// Measured offline: a crushed loud master (-10 LUFS, peaks at 0 dBFS) and a
// normal song both come out at about -20 LUFS with peaks near -10 dBFS and no
// clipped samples; total work is roughly twice the old single conversion.
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import ffmpegPath from 'ffmpeg-static';

// q3: downmix-correct order and in-pass loudness measurement (q2 was the first test build).
export const PHONE_AUDIO_VERSION = 'q3';
const num = (v, d) => { const n = Number(v); return Number.isFinite(n) ? n : d; };

export function phoneAudioSettings(env = process.env) {
  return {
    // Moderate phone level: clearly audible, never "maximum volume".
    targetLufs: Math.max(-30, Math.min(-14, num(env.BRANCH2_AUDIO_TARGET_LUFS, -18))),
    // Hard output ceiling (dBFS). Kept well below 0 so the phone codec never distorts.
    ceilingDb: Math.max(-12, Math.min(-1, num(env.BRANCH2_AUDIO_CEILING_DB, -4.5))),
    maxBoostDb: Math.max(0, Math.min(32, num(env.BRANCH2_AUDIO_MAX_BOOST_DB, 29))),
    maxCutDb: Math.max(0, Math.min(30, num(env.BRANCH2_AUDIO_MAX_CUT_DB, 20))),
    highpassHz: Math.max(40, Math.min(300, num(env.BRANCH2_AUDIO_HIGHPASS_HZ, 140))),
    lowpassHz: Math.max(3000, Math.min(3900, num(env.BRANCH2_AUDIO_LOWPASS_HZ, 3500))),
    presenceDb: Math.max(0, Math.min(4, num(env.BRANCH2_AUDIO_PRESENCE_DB, 1.5))),
  };
}

let soxrProbe = null;
// The production ffmpeg build is different from a developer machine; use the
// SoX resampler only when this build really has it, otherwise ffmpeg's own.
export function hasSoxr(run = runFfmpeg) {
  if (!soxrProbe) {
    soxrProbe = run(['-nostdin', '-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'anullsrc=r=44100:cl=mono',
      '-t', '0.1', '-af', 'aresample=8000:resampler=soxr', '-f', 'null', '-'], { timeoutMs: 15000 })
      .then(() => true, () => false)
      .then(ok => { console.info('[YouTube IVR] phone audio resampler', { soxr: ok }); return ok; });
  }
  return soxrProbe;
}

// Downmix and drop to 8kHz first (filters then run on 6x fewer samples), and
// measure loudness (ebur128) in the same pass, so the only real cost is the
// source decode the old conversion paid anyway.
export function prepassFilter(s, soxr, sampleRate = 8000) {
  const phone = sampleRate <= 8000;
  const resample = soxr ? `aresample=${sampleRate}:resampler=soxr` : `aresample=${sampleRate}:filter_size=64:cutoff=0.97`;
  return [
    // aresample must directly follow aformat: it then performs the downmix as
    // a true average (L+R)/2. With any filter in between, ffmpeg inserts an
    // automatic converter that sums 3dB hotter (measured), which only risks
    // overload on loud masters.
    'aformat=channel_layouts=mono',
    resample,
    // Full-band (non-phone) rendering keeps the deep bass and the highs.
    `highpass=f=${phone ? s.highpassHz : 30}:poles=2`,
    ...(phone ? [`lowpass=f=${s.lowpassHz}:poles=2`] : []),
    ...(phone && s.presenceDb > 0 ? [`equalizer=f=2200:t=o:w=1.2:g=${s.presenceDb}`] : []),
    'volume=-6dB',
    'ebur128=framelog=verbose', // summary only; no per-frame lines
  ].join(',');
}

export function gainFor(measuredLufs, s) {
  if (!Number.isFinite(measuredLufs) || measuredLufs < -70) return 0; // silence/unknown: never blast noise
  return Math.max(-s.maxCutDb, Math.min(s.maxBoostDb, s.targetLufs - measuredLufs));
}

export function finishFilter(gainDb, s) {
  const limit = Math.pow(10, s.ceilingDb / 20).toFixed(4);
  return [
    // The limiter needs a few ms of look-ahead before it can act; a 30ms
    // fade-in (inaudible) keeps the very first samples under the ceiling too
    // and avoids a click when playback starts.
    'afade=t=in:d=0.03',
    `volume=${gainDb.toFixed(2)}dB`,
    'acompressor=threshold=0.18:ratio=2:attack=8:release=150:knee=6',
    `alimiter=limit=${limit}:attack=3:release=60:level=disabled`,
    'aresample=osf=s16:dither_method=triangular',
  ].join(',');
}

export function parseIntegratedLufs(stderr) {
  const all = [...String(stderr).matchAll(/I:\s+(-?[\d.]+|-inf)\s+LUFS/g)];
  if (!all.length) return null;
  const v = all[all.length - 1][1];
  return v === '-inf' ? -Infinity : Number(v);
}

// onTime(seconds, inputDurationSeconds|null) receives ffmpeg's real position in
// the file when "-progress pipe:2" is in args (measured, never estimated).
export function runFfmpeg(args, { signal, timeoutMs = 10800000, collect = false, onTime } = {}) {
  return new Promise((resolve, reject) => {
    if (!ffmpegPath) return reject(new Error('ffmpeg-static is unavailable'));
    const child = spawn(ffmpegPath, args, { stdio: ['ignore', 'ignore', 'pipe'] });
    let err = '', partial = '', inputDuration = null;
    child.stderr.on('data', d => {
      partial += d;
      const lines = partial.split(/\r?\n/); partial = lines.pop();
      for (const line of lines) {
        const t = line.match(/^out_time_(?:us|ms)=(\d+)$/);
        if (t) { try { onTime?.(Number(t[1]) / 1e6, inputDuration); } catch {} continue; }
        if (/^[a-z_]+=\S*$/.test(line)) continue; // other -progress keys
        const dur = inputDuration === null && line.match(/Duration:\s+(\d+):(\d\d):(\d\d(?:\.\d+)?)/);
        if (dur) inputDuration = Number(dur[1]) * 3600 + Number(dur[2]) * 60 + Number(dur[3]);
        err += line + '\n';
        if (!collect && err.length > 20000) err = err.slice(-10000);
      }
    });
    const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error('ffmpeg timed out')); }, timeoutMs);
    const onAbort = () => { child.kill('SIGKILL'); clearTimeout(timer); reject(Object.assign(new Error('ffmpeg aborted'), { code: 'aborted' })); };
    if (signal?.aborted) return onAbort();
    signal?.addEventListener('abort', onAbort, { once: true });
    child.on('error', e => { clearTimeout(timer); reject(e); });
    child.on('close', code => {
      clearTimeout(timer); signal?.removeEventListener('abort', onAbort);
      err += partial;
      code === 0 ? resolve(err) : reject(Object.assign(new Error('ffmpeg failed (' + code + '): ' + err.slice(-400)), { code: 'ffmpeg_failed' }));
    });
  });
}

// Converts any source into one phone-mastered WAV at `output`.
// Returns measurements for the logs. Temporary files live next to `output`.
export async function preparePhoneAudio(source, output, { signal, env = process.env, run = runFfmpeg, onStage = () => {}, sampleRate = 8000, onPercent = () => {} } = {}) {
  const s = phoneAudioSettings(env);
  const soxr = await hasSoxr(run);
  const inter = path.join(path.dirname(output), 'phone-prepass.wav');
  const t0 = Date.now();
  onStage('preparing');
  // ebur128 prints its summary at info level, so no -loglevel error here.
  // Real progress: ffmpeg's position in the file / the file's length. The first
  // pass (decode + filters) is ~70% of the work, the second ~30% (measured).
  let lastPct = -1;
  const pct = (from, span) => (sec, dur) => {
    if (!(dur > 0)) return;
    const p = Math.min(99, Math.floor(from + span * Math.min(1, sec / dur)));
    if (p > lastPct) { lastPct = p; try { onPercent(p); } catch {} }
  };
  const report = await run(['-nostdin', '-hide_banner', '-nostats', '-progress', 'pipe:2', '-stats_period', '2', '-xerror', '-y', '-i', source, '-vn',
    '-af', prepassFilter(s, soxr, sampleRate), '-ac', '1', '-ar', String(sampleRate), '-c:a', 'pcm_s16le', inter], { signal, collect: true, onTime: pct(0, 70) });
  const t1 = Date.now();
  const measuredLufs = parseIntegratedLufs(report);
  const gainDb = gainFor(measuredLufs, s);
  const t2 = Date.now();
  const interSeconds = Math.max(0, ((await fs.stat(inter)).size - 44) / (sampleRate * 2));
  const finishTime = pct(70, 30);
  await run(['-nostdin', '-hide_banner', '-loglevel', 'error', '-progress', 'pipe:2', '-stats_period', '2', '-xerror', '-y', '-i', inter,
    '-af', finishFilter(gainDb, s), '-ac', '1', '-ar', String(sampleRate), '-c:a', 'pcm_s16le',
    // Plain canonical 44-byte WAV header (no encoder LIST chunk) for Yemot.
    '-map_metadata', '-1', '-fflags', '+bitexact', '-flags:a', '+bitexact', output], { signal, onTime: sec => finishTime(sec, interSeconds) });
  await fs.rm(inter, { force: true }).catch(() => {});
  const stat = await fs.stat(output);
  const durationSec = Math.max(0, (stat.size - 44) / (sampleRate * 2));
  const result = { version: PHONE_AUDIO_VERSION, sampleRate, measuredLufs, gainDb: Number(gainDb.toFixed(2)), soxr,
    durationSec: Number(durationSec.toFixed(1)), bytes: stat.size,
    ms: { prepass: t1 - t0, measure: t2 - t1, finish: Date.now() - t2 } };
  console.info('[YouTube IVR] phone audio mastered', result);
  return result;
}
