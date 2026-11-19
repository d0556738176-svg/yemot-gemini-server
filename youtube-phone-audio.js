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
import { existsSync } from 'node:fs';

// q3: downmix-correct order and in-pass loudness measurement (q2 was the first test build).
export const PHONE_AUDIO_VERSION = 'q3';
// q4 (owner, 18.11): his file spec - WAV PCM, mono, 16kHz, 16-bit, peak
// normalized to -2dB (-3dB for songs, which are full of instruments), lessons
// with the rumble below 100Hz cut and a gentle noise reduction. Logs only:
// PHONE_AUDIO_VERSION stays, so file names, caches and paid self-tests keep.
export const PHONE_MASTER_VERSION = 'q4';
// Lesson / talk words in titles (Hebrew and English); song words win over them.
const LESSON_WORDS = /(שיעור|שיעורי|הרב\s|הרה"ג|הגאון|דרשה|דרשת|שיחה|שיחת|הרצאה|הרצאת|פרשת|דף\s?היומי|דף\s?יומי|גמרא|הלכה|הלכות|מוסר|חיזוק|עצות|כנס|\bshiur|\blecture|\brabbi\b|\brav\s|\bsermon|\btalk\b|\bpodcast|\bparsha)/i;
const SONG_WORDS = /(ניגון|ניגונים|שיר\b|שירי\b|שירים|מחרוזת|אלבום|קליפ|סינגל|ווקאלי|מוזיקה|\bsong|\bnigun|\bniggun|\bmedley|\balbum|\bsingle\b|\bofficial\b|\bmusic\b|\bclip\b|\bfeat\.?|\bft\.)/i;
// 'lesson' (shiur, talk) or 'song'. A forced kind (BRANCH2_AUDIO_KIND) wins;
// otherwise the title decides, and an unclear title over 30 minutes is a lesson.
export function audioKind({ title = '', durationSec = null, env = process.env } = {}) {
  const forced = String(env.BRANCH2_AUDIO_KIND || '').toLowerCase();
  if (forced === 'lesson' || forced === 'song') return forced;
  const t = String(title || '');
  if (SONG_WORDS.test(t)) return 'song';
  if (LESSON_WORDS.test(t)) return 'lesson';
  return Number(durationSec) >= 1800 ? 'lesson' : 'song';
}
const num = (v, d) => { const n = Number(v); return Number.isFinite(n) ? n : d; };

export function phoneAudioSettings(env = process.env) {
  return {
    // Owner's spec, 18.11: files are made at 16kHz / 16-bit / mono WAV.
    sampleRate: [8000, 16000].includes(num(env.BRANCH2_PHONE_RATE, 16000)) ? num(env.BRANCH2_PHONE_RATE, 16000) : 16000,
    // Final sample peak: -2dB (lessons), -3dB (songs full of instruments).
    lessonPeakDb: Math.max(-6, Math.min(-1, num(env.BRANCH2_AUDIO_LESSON_PEAK_DB, -2))),
    songPeakDb: Math.max(-6, Math.min(-1, num(env.BRANCH2_AUDIO_SONG_PEAK_DB, -3))),
    lessonHighpassHz: Math.max(40, Math.min(200, num(env.BRANCH2_AUDIO_LESSON_HIGHPASS_HZ, 100))),
    // Gentle noise reduction for lessons (dB removed from steady background noise); 0 = off.
    lessonDenoiseDb: Math.max(0, Math.min(20, num(env.BRANCH2_AUDIO_LESSON_DENOISE_DB, 8))),
    // Moderate phone level: clearly audible, never "maximum volume".
    targetLufs: Math.max(-30, Math.min(-14, num(env.BRANCH2_AUDIO_TARGET_LUFS, -18))),
    // Hard output ceiling (dBFS). Kept well below 0 so the phone codec never distorts.
    ceilingDb: Math.max(-12, Math.min(-1, num(env.BRANCH2_AUDIO_CEILING_DB, -4.5))),
    maxBoostDb: Math.max(0, Math.min(32, num(env.BRANCH2_AUDIO_MAX_BOOST_DB, 29))),
    maxCutDb: Math.max(0, Math.min(30, num(env.BRANCH2_AUDIO_MAX_CUT_DB, 20))),
    // Owner, 15.11 08:32: chose sample 2 ("less bass, soft"): band 140-3500 Hz,
    // no lift of the voice band, gentle de-esser. Before that:
    // the band opened at both ends (bass/drums below, strings/cymbals above)
    // and less lift of the voice band. Warmth, de-esser, space and bass
    // harmonics stay available by setting but are off.
    highpassHz: Math.max(40, Math.min(300, num(env.BRANCH2_AUDIO_HIGHPASS_HZ, 140))),
    // Warmth (body of voice and guitar) and a gentle de-esser: the phone
    // line's own coding turns sharp "s" and cymbal spikes into a rasp (15.11).
    warmthDb: Math.max(0, Math.min(4, num(env.BRANCH2_AUDIO_WARMTH_DB, 0))),
    deess: Math.max(0, Math.min(1, num(env.BRANCH2_AUDIO_DEESS, 0.3))),
    // The space of the recording (hall, crowd, reverb, wide instruments) lives
    // in the stereo difference, which a plain mono mix throws away: part of it
    // is kept, slightly delayed so it does not cancel the middle (15.11).
    ambience: Math.max(0, Math.min(0.8, num(env.BRANCH2_AUDIO_AMBIENCE, 0))),
    // Bass and drums are below what a phone line carries; their harmonics are
    // made audible instead, so the ear still hears the bass line (15.11).
    virtualBass: Math.max(0, Math.min(1, num(env.BRANCH2_AUDIO_VBASS, 0))),
    lowpassHz: Math.max(3000, Math.min(3900, num(env.BRANCH2_AUDIO_LOWPASS_HZ, 3500))),
    presenceDb: Math.max(0, Math.min(4, num(env.BRANCH2_AUDIO_PRESENCE_DB, 0))),
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
export function prepassFilter(s, soxr, sampleRate = 8000, kind = 'song') {
  const phone = sampleRate <= 16000;
  const lesson = phone && kind === 'lesson';
  const resample = soxr ? `aresample=${sampleRate}:resampler=soxr` : `aresample=${sampleRate}:filter_size=64:cutoff=0.97`;
  const tone = [
    // Full-band (non-phone) rendering keeps the deep bass and the highs.
    `highpass=f=${!phone ? 30 : lesson ? s.lessonHighpassHz : s.highpassHz}:poles=2`,
    // Lessons: gentle reduction of steady background noise (fan, hum, hiss).
    ...(lesson && s.lessonDenoiseDb > 0 ? [`afftdn=nr=${s.lessonDenoiseDb}:nf=-50:tn=1`] : []),
    ...(phone ? [`lowpass=f=${s.lowpassHz}:poles=2`] : []),
    ...(phone && s.warmthDb > 0 ? [`equalizer=f=280:t=o:w=1.2:g=${s.warmthDb}`] : []),
    ...(phone && s.presenceDb > 0 ? [`equalizer=f=2200:t=o:w=1.2:g=${s.presenceDb}`] : []),
    ...(phone && s.deess > 0 ? [`deesser=i=${s.deess}:m=0.5:f=0.5:s=o`] : []),
    'volume=-6dB',
    'ebur128=framelog=verbose', // summary only; no per-frame lines
  ].join(',');
  if (!phone || lesson || (!(s.ambience > 0) && !(s.virtualBass > 0))) {
    // aresample must directly follow aformat: it then performs the downmix as
    // a true average (L+R)/2. With any filter in between, ffmpeg inserts an
    // automatic converter that sums 3dB hotter (measured).
    return ['aformat=channel_layouts=mono', resample, tone].join(',');
  }
  // Phone: middle (L+R)/2 and the space (L-R)/2 with exact pan factors (a mono
  // source is copied to both sides, so its space is silence), then the bass
  // harmonics, then the same tone shaping as before.
  const graph = ['aformat=channel_layouts=stereo,asplit=2[pm][ps]',
    `[pm]pan=mono|c0=0.5*c0+0.5*c1,${resample}[mid]`];
  let last = 'mid';
  if (s.ambience > 0) {
    graph.push(`[ps]pan=mono|c0=0.5*c0-0.5*c1,${resample},highpass=f=300:poles=2,adelay=15,volume=${s.ambience}[side]`,
      '[mid][side]amix=inputs=2:normalize=0:duration=first[wide]');
    last = 'wide';
  } else graph.push('[ps]anullsink');
  if (s.virtualBass > 0) {
    graph.push(`[${last}]asplit=2[dry][low]`,
      `[low]lowpass=f=180:poles=2,volume=14dB,asoftclip=type=tanh,highpass=f=240:poles=2,lowpass=f=900:poles=2,volume=${s.virtualBass}[harm]`,
      '[dry][harm]amix=inputs=2:normalize=0:duration=first[full]');
    last = 'full';
  }
  graph.push(`[${last}]${tone}`);
  return graph.join(';');
}

export function gainFor(measuredLufs, s) {
  if (!Number.isFinite(measuredLufs) || measuredLufs < -70) return 0; // silence/unknown: never blast noise
  return Math.max(-s.maxCutDb, Math.min(s.maxBoostDb, s.targetLufs - measuredLufs));
}

// peakDb (q4): the limiter catches every spike at the final peak target; the
// last pass then raises the whole file until its highest sample is exactly there.
export function finishFilter(gainDb, s, peakDb = null) {
  const limit = Math.pow(10, (peakDb ?? s.ceilingDb) / 20).toFixed(4);
  return [
    // The limiter needs a few ms of look-ahead before it can act; a 30ms
    // fade-in (inaudible) keeps the very first samples under the ceiling too
    // and avoids a click when playback starts.
    'afade=t=in:d=0.03',
    `volume=${gainDb.toFixed(2)}dB`,
    // Owner, 15.11: the original (q3) dynamics are kept, he prefers them.
    'acompressor=threshold=0.18:ratio=2:attack=8:release=150:knee=6',
    `alimiter=limit=${limit}:attack=3:release=60:level=disabled`,
    ...(peakDb === null ? ['aresample=osf=s16:dither_method=triangular'] : ['volumedetect']),
  ].join(',');
}

// Gain that brings the highest sample to the target; only ever raises (the
// limiter already holds everything at or under the target).
export function peakGainFor(maxVolumeDb, peakDb) {
  if (!Number.isFinite(maxVolumeDb) || maxVolumeDb < -60) return 0;
  return Math.max(0, Math.min(20, peakDb - maxVolumeDb - 0.05));
}
export function parseMaxVolume(stderr) {
  const m = [...String(stderr).matchAll(/max_volume:\s+(-?[\d.]+|-inf) dB/g)].pop();
  return !m ? null : m[1] === '-inf' ? -Infinity : Number(m[1]);
}
async function inputDuration(source, run) {
  try { await run(['-nostdin', '-hide_banner', '-i', source], { timeoutMs: 30000, collect: true }); }
  catch (e) { const d = String(e?.stderr || e?.message || '').match(/Duration:\s+(\d+):(\d\d):(\d\d(?:\.\d+)?)/); if (d) return +d[1] * 3600 + +d[2] * 60 + +d[3]; }
  return null;
}

export function parseIntegratedLufs(stderr) {
  const all = [...String(stderr).matchAll(/I:\s+(-?[\d.]+|-inf)\s+LUFS/g)];
  if (!all.length) return null;
  const v = all[all.length - 1][1];
  return v === '-inf' ? -Infinity : Number(v);
}

// onTime(seconds, inputDurationSeconds|null) receives ffmpeg's real position in
// the file when "-progress pipe:2" is in args (measured, never estimated).
// 18.11: the bundled ffmpeg crashes (killed by a signal, exit "null") on
// some site recordings (mako). The same work is then done once more with the
// server's own ffmpeg, so the file is still made, with the same settings.
const SYSTEM_FFMPEG = ['/usr/bin/ffmpeg', '/usr/local/bin/ffmpeg'].find(p => existsSync(p)) || null;
export async function runFfmpeg(args, opts = {}) {
  try { return await runFfmpegWith(ffmpegPath, args, opts); }
  catch (e) {
    if (!e?.crashed || !SYSTEM_FFMPEG || SYSTEM_FFMPEG === ffmpegPath || opts.signal?.aborted) throw e;
    console.warn('[PHONE_AUDIO] bundled ffmpeg crashed; doing it with the server ffmpeg', { signal: e.crashed });
    return runFfmpegWith(SYSTEM_FFMPEG, args, opts);
  }
}

function runFfmpegWith(bin, args, { signal, timeoutMs = 10800000, collect = false, onTime } = {}) {
  return new Promise((resolve, reject) => {
    if (!bin) return reject(new Error('ffmpeg-static is unavailable'));
    const child = spawn(bin, args, { stdio: ['ignore', 'ignore', 'pipe'] });
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
    child.on('close', (code, sig) => {
      clearTimeout(timer); signal?.removeEventListener('abort', onAbort);
      err += partial;
      code === 0 ? resolve(err) : reject(Object.assign(new Error('ffmpeg failed (' + code + '): ' + err.slice(-400)), { code: 'ffmpeg_failed', stderr: err.slice(-20000), crashed: code === null && sig && sig !== 'SIGKILL' ? sig : null }));
    });
  });
}

// Converts any source into one phone-mastered WAV at `output`.
// Returns measurements for the logs. Temporary files live next to `output`.
export async function preparePhoneAudio(source, output, { signal, env = process.env, run = runFfmpeg, onStage = () => {}, sampleRate = null, onPercent = () => {}, title = '', kind = null } = {}) {
  const s = phoneAudioSettings(env);
  sampleRate = sampleRate || s.sampleRate;
  const soxr = await hasSoxr(run);
  const inter = path.join(path.dirname(output), 'phone-prepass.wav');
  const inter2 = path.join(path.dirname(output), 'phone-level.wav');
  const t0 = Date.now();
  onStage('preparing');
  kind = kind || audioKind({ title, durationSec: kind ? null : await inputDuration(source, run), env });
  const peakDb = kind === 'lesson' ? s.lessonPeakDb : s.songPeakDb;
  // ebur128 prints its summary at info level, so no -loglevel error here.
  // Real progress: ffmpeg's position in the file / the file's length. The first
  // pass (decode + filters) is ~70% of the work, the other two ~30% (measured).
  let lastPct = -1;
  const pct = (from, span) => (sec, dur) => {
    if (!(dur > 0)) return;
    const p = Math.min(99, Math.floor(from + span * Math.min(1, sec / dur)));
    if (p > lastPct) { lastPct = p; try { onPercent(p); } catch {} }
  };
  const report = await run(['-nostdin', '-hide_banner', '-nostats', '-progress', 'pipe:2', '-stats_period', '2', '-xerror', '-y', '-i', source, '-vn',
    '-af', prepassFilter(s, soxr, sampleRate, kind), '-ac', '1', '-ar', String(sampleRate), '-c:a', 'pcm_s16le', inter], { signal, collect: true, onTime: pct(0, 70) });
  const t1 = Date.now();
  const measuredLufs = parseIntegratedLufs(report);
  const gainDb = gainFor(measuredLufs, s);
  const interSeconds = Math.max(0, ((await fs.stat(inter)).size - 44) / (sampleRate * 2));
  // Pass 2: level, gentle compressor, every spike held at the peak target;
  // kept in float and measured (volumedetect) so pass 3 sets the exact peak.
  const levelTime = pct(70, 20);
  const levelReport = await run(['-nostdin', '-hide_banner', '-nostats', '-progress', 'pipe:2', '-stats_period', '2', '-xerror', '-y', '-i', inter,
    '-af', finishFilter(gainDb, s, peakDb), '-ac', '1', '-ar', String(sampleRate), '-c:a', 'pcm_f32le', inter2],
    { signal, collect: true, onTime: sec => levelTime(sec, interSeconds) });
  await fs.rm(inter, { force: true }).catch(() => {});
  const maxBeforeDb = parseMaxVolume(levelReport);
  const peakGainDb = peakGainFor(maxBeforeDb, peakDb);
  const t2 = Date.now();
  const finishTime = pct(90, 10);
  // Pass 3 (Normalize): the highest sample lands on the target, then 16-bit with dither.
  const limit = Math.pow(10, peakDb / 20).toFixed(4);
  await run(['-nostdin', '-hide_banner', '-loglevel', 'error', '-progress', 'pipe:2', '-stats_period', '2', '-xerror', '-y', '-i', inter2,
    '-af', `volume=${peakGainDb.toFixed(2)}dB,alimiter=limit=${limit}:attack=1:release=50:level=disabled,aresample=osf=s16:dither_method=triangular`,
    '-ac', '1', '-ar', String(sampleRate), '-c:a', 'pcm_s16le',
    // Plain canonical 44-byte WAV header (no encoder LIST chunk) for Yemot.
    '-map_metadata', '-1', '-fflags', '+bitexact', '-flags:a', '+bitexact', output], { signal, onTime: sec => finishTime(sec, interSeconds) });
  await fs.rm(inter2, { force: true }).catch(() => {});
  const stat = await fs.stat(output);
  const durationSec = Math.max(0, (stat.size - 44) / (sampleRate * 2));
  const result = { version: PHONE_AUDIO_VERSION, master: PHONE_MASTER_VERSION, kind, peakTargetDb: peakDb, sampleRate, measuredLufs,
    gainDb: Number(gainDb.toFixed(2)), peakGainDb: Number(peakGainDb.toFixed(2)), soxr,
    durationSec: Number(durationSec.toFixed(1)), bytes: stat.size,
    ms: { prepass: t1 - t0, level: t2 - t1, finish: Date.now() - t2 } };
  console.info('[YouTube IVR] phone audio mastered', result);
  return result;
}
