// Hebrew dubbing of a saved song/video sound (owner, 07.11: key 9 in
// extensions 7/8, after confirming with 1).
//
// The original sound is fetched again at full quality, its speech is written
// down with word timings in its own language (shared code with the
// subtitles), grouped into sentences and translated for speaking. Each
// sentence is spoken by a Hebrew neural voice and placed at the time the
// original sentence was said (a little faster when the Hebrew is longer, never
// over the next sentence). The original sound stays underneath as the
// background: lowered while the Hebrew voice speaks, full between sentences
// (the usual "voice-over" dubbing). The result becomes a new file in the
// regular list (extension 7, newest first) and a download copy with all the
// details in the audio folder. Only audio is processed, so it is fast even on
// the free server.
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import { createWriteStream } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { transcribeMedia, buildCues, translateCues } from './youtube-subtitles.js';

const sleep = ms => new Promise(r => setTimeout(r, ms));

function run(ffmpegPath, args, { stdin = null } = {}) {
  return new Promise((resolve, reject) => {
    const p = spawn(ffmpegPath, args, { stdio: [stdin ? 'pipe' : 'ignore', 'ignore', 'pipe'] });
    let e = ''; p.stderr.on('data', d => { e = (e + d).slice(-400); });
    p.on('error', reject);
    p.on('close', c => (c === 0 ? resolve() : reject(new Error('ffmpeg ' + c + ': ' + e.trim()))));
    if (stdin) Promise.resolve().then(() => stdin(p.stdin)).catch(err => { try { p.kill('SIGKILL'); } catch {} reject(err); });
  });
}

async function seconds(ffmpegPath, file) {
  const info = await new Promise(res => { const c = spawn(ffmpegPath, ['-hide_banner', '-i', file]); let e = ''; c.stderr.on('data', d => { e += d; }); c.on('close', () => res(e)); c.on('error', () => res('')); });
  const m = /Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/.exec(info);
  return m ? (+m[1]) * 3600 + (+m[2]) * 60 + (+m[3]) : 0;
}

// Cues -> spoken sentences (a pause, a sentence end or 12 s closes one).
export function groupSentences(cues) {
  const out = []; let cur = null;
  for (const c of cues || []) {
    if (cur && (c.start - cur.end > 0.8 || c.end - cur.start > 12 || (/[.?!]$/.test(cur.text) && cur.end - cur.start >= 2))) { out.push(cur); cur = null; }
    if (!cur) cur = { start: c.start, end: c.end, text: c.text };
    else { cur.end = c.end; cur.text += ' ' + c.text; }
  }
  if (cur) out.push(cur);
  return out;
}

const DUB_SYSTEM = 'אתה מתרגם לדיבוב. תקבל מערך JSON של משפטים מדוברים מסרטון, לפי הסדר. תרגם כל משפט לעברית מדוברת, טבעית וזורמת, בשפה נקייה ומכובדת, באורך דומה למקור ככל האפשר (הדיבוב צריך להיכנס באותו זמן), בהתאם להקשר של המשפטים הסמוכים. כתוב מספרים במילים כשזה עוזר להקראה. החזר רק מערך JSON של מחרוזות באותו אורך ובאותו סדר בדיוק.';

// ---- Hebrew voice ----------------------------------------------------------
// Microsoft's neural Hebrew voices (the free Edge "read aloud" service), then
// Google's simple voice as a last resort, so a sentence is never left silent.
let edge = null;
async function edgeSpeak(text, out, env) {
  const { MsEdgeTTS, OUTPUT_FORMAT } = await import('msedge-tts');
  if (!edge) {
    edge = new MsEdgeTTS({ connectionTimeoutMs: 15000, synthesisTimeoutMs: 60000 });
    await edge.setMetadata(env.DUB_VOICE || 'he-IL-AvriNeural', OUTPUT_FORMAT.AUDIO_24KHZ_96KBITRATE_MONO_MP3);
  }
  const esc = String(text).replace(/[<>&"']/g, c => ({ '<': ' ', '>': ' ', '&': ' ו ', '"': ' ', "'": '' }[c]));
  const { audioStream } = edge.toStream(esc);
  const chunks = [];
  await new Promise((res, rej) => { audioStream.on('data', d => chunks.push(d)); audioStream.on('close', res); audioStream.on('end', res); audioStream.on('error', rej); });
  const buf = Buffer.concat(chunks);
  if (buf.length < 500) throw new Error('empty voice');
  await fs.writeFile(out, buf);
}
async function googleSpeak(text, out, fetchImpl) {
  const parts = []; let cur = '';
  for (const w of String(text).split(/\s+/)) { if ((cur + ' ' + w).length > 180) { parts.push(cur); cur = w; } else cur = cur ? cur + ' ' + w : w; }
  if (cur) parts.push(cur);
  const bufs = [];
  for (const q of parts) {
    const r = await fetchImpl('https://translate.google.com/translate_tts?' + new URLSearchParams({ ie: 'UTF-8', tl: 'iw', client: 'tw-ob', q }), { headers: { 'user-agent': 'Mozilla/5.0' }, signal: AbortSignal.timeout(20000) });
    if (!r.ok) throw new Error('google voice HTTP ' + r.status);
    bufs.push(Buffer.from(await r.arrayBuffer()));
  }
  await fs.writeFile(out, Buffer.concat(bufs));
}
export async function speakHebrew(text, out, { env = process.env, fetchImpl = fetch, log = console } = {}) {
  for (let i = 0; i < 3; i++) {
    try { await edgeSpeak(text, out, env); return 'edge'; }
    catch (e) { edge = null; if (i === 2) log.warn?.('[DUB] neural voice failed; simple voice used', { message: String(e?.message || e).slice(0, 120) }); else await sleep(1500 * (i + 1)); }
  }
  await googleSpeak(text, out, fetchImpl);
  return 'google';
}

// The Hebrew sentences placed on one voice track (in order, never covering the
// next) and mixed over the original, which is lowered while speech is heard.
// clips: [{ file, start, slot, dur }]; sentences: original [{start, end}].
export async function buildDubMix(source, clips, sentences, total, temp, ffmpegPath) {
    // One voice track, written in order (a sentence never covers the next).
    const RATE = 24000;
    const voice = path.join(temp, 'voice.flac');
    const windows = [];
    await run(ffmpegPath, ['-hide_banner', '-loglevel', 'error', '-y', '-f', 's16le', '-ar', String(RATE), '-ac', '1', '-i', 'pipe:0', '-c:a', 'flac', voice], {
      stdin: async sink => {
        let at = 0; // seconds written so far
        const write = b => new Promise(res => (sink.write(b) ? res() : sink.once('drain', res)));
        try {
          for (const c of clips) {
            if (!c || !c.dur) continue;
            const tempo = c.dur > c.slot ? Math.min(1.6, c.dur / c.slot) : 1;
            const pcm = await new Promise((res, rej) => {
              const p = spawn(ffmpegPath, ['-hide_banner', '-loglevel', 'error', '-i', c.file, '-af', (tempo > 1.01 ? 'atempo=' + tempo.toFixed(3) + ',' : '') + 'aresample=' + RATE, '-ac', '1', '-f', 's16le', 'pipe:1']);
              const parts = []; p.stdout.on('data', d => parts.push(d)); p.on('error', rej);
              p.on('close', code => (code === 0 ? res(Buffer.concat(parts)) : rej(new Error('voice decode ' + code))));
            });
            const startAt = Math.max(c.start, at + 0.05);
            const gap = Math.round((startAt - at) * RATE) * 2;
            if (gap > 0) for (let left = gap; left > 0; left -= 1 << 20) await write(Buffer.alloc(Math.min(left, 1 << 20)));
            await write(pcm);
            const len = pcm.length / 2 / RATE;
            windows.push([startAt, startAt + len]);
            at = startAt + len;
          }
          const tail = Math.round(Math.max(0, total - at) * RATE) * 2;
          for (let left = tail; left > 0; left -= 1 << 20) await write(Buffer.alloc(Math.min(left, 1 << 20)));
        } finally { sink.end(); }
      },
    });

    // The original underneath: lowered to about a fifth while Hebrew is spoken
    // (and around the original sentences), full in between.
    const duck = [];
    for (const [a, b] of [...windows, ...sentences.map(s => [s.start, s.end])].sort((x, y) => x[0] - y[0])) {
      const w = [Math.max(0, a - 0.25), b + 0.3];
      const last = duck[duck.length - 1];
      if (last && w[0] <= last[1] + 0.4) last[1] = Math.max(last[1], w[1]); else duck.push(w);
    }
    const inside = duck.length ? duck.map(([a, b]) => 'between(t,' + a.toFixed(2) + ',' + b.toFixed(2) + ')').join('+') : '0';
    const script = path.join(temp, 'mix.txt');
    await fs.writeFile(script,
      "[0:a]aresample=44100,aformat=channel_layouts=stereo,volume='1-0.8*min(1," + inside + ")':eval=frame[bg];" +
      '[1:a]aresample=44100,aformat=channel_layouts=stereo,volume=1.5[v];' +
      '[bg][v]amix=inputs=2:duration=first:normalize=0,alimiter=limit=0.95[out]');
    const mix = path.join(temp, 'dubbed.flac');
    await run(ffmpegPath, ['-hide_banner', '-loglevel', 'error', '-y', '-i', source, '-i', voice, '-filter_complex_script', script, '-map', '[out]', '-c:a', 'flac', mix]);
    return mix;
}

// ---- the whole dubbing -------------------------------------------------------
// deps: ffmpegPath, fetchSource(videoId, outFile), preparePhone(src, outWav),
//       publishExt7(id, wav, title), saveDownload(videoId, mixFile, title, tempDir, durationSec, suffix)
export async function dubToHebrew({ videoId, title }, deps, { env = process.env, fetchImpl = fetch, log = console } = {}) {
  const { ffmpegPath } = deps;
  const t0 = Date.now();
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'dub-'));
  try {
    const source = path.join(temp, 'source');
    await deps.fetchSource(videoId, source);
    const total = await seconds(ffmpegPath, source);
    log.info?.('[DUB] original sound ready', { videoId, minutes: +(total / 60).toFixed(1) });

    const tr = await transcribeMedia(source, temp, { ffmpegPath, env, fetchImpl, log, seconds: total });
    if (!tr || tr.words.length < 5) return { state: 'no_speech' };
    if (tr.hebrew) { log.info?.('[DUB] the speech is already Hebrew; nothing to dub', { videoId }); return { state: 'already_hebrew' }; }
    const sentences = groupSentences(buildCues(tr.words));
    const { cues: he, translated } = await translateCues(sentences, { env, fetchImpl, log, system: DUB_SYSTEM, batch: 15 });
    if (!translated) throw Object.assign(new Error('translation unavailable'), { code: 'dub_translation_failed' });
    log.info?.('[DUB] translated', { videoId, language: tr.language, sentences: he.length, translated });

    // Voice for every sentence (4 at a time), fitted into its time slot.
    const clips = new Array(he.length);
    let next = 0, voiceKinds = {};
    const worker = async () => {
      while (next < he.length) {
        const i = next++;
        const s = he[i];
        const raw = path.join(temp, 'v' + i + '.mp3');
        try {
          const kind = await speakHebrew(s.text, raw, { env, fetchImpl, log });
          voiceKinds[kind] = (voiceKinds[kind] || 0) + 1;
          clips[i] = { file: raw, start: s.start, slot: Math.max(0.6, ((he[i + 1]?.start ?? total) - s.start) - 0.08), dur: await seconds(ffmpegPath, raw) };
        } catch (e) { log.warn?.('[DUB] a sentence has no voice', { i, message: String(e?.message || e).slice(0, 100) }); }
      }
    };
    await Promise.all(Array.from({ length: 4 }, worker));
    log.info?.('[DUB] voices ready', { videoId, clips: clips.filter(Boolean).length, voice: voiceKinds });

    const mix = await buildDubMix(source, clips, sentences, total, temp, ffmpegPath);
    log.info?.('[DUB] mixed with the original background', { videoId, minutes: +((Date.now() - t0) / 60000).toFixed(1) });

    // The regular list (extension 7) and a download copy with all details.
    const phone = path.join(temp, 'phone.wav');
    await deps.preparePhone(mix, phone);
    const dubTitle = String(title || videoId) + ' - דיבוב לעברית';
    const entry = await deps.publishExt7(videoId + '-he', phone, dubTitle);
    await deps.saveDownload(videoId, mix, title, temp, total, ' - דיבוב לעברית').catch(e => log.warn?.('[DUB] download copy not saved', { message: String(e?.message || e).slice(0, 160) }));
    log.info?.('[DUB] done', { videoId, ext7File: entry?.file, sentences: he.length, minutes: +((Date.now() - t0) / 60000).toFixed(1) });
    return { state: 'done', file: entry?.file || null };
  } finally {
    await fs.rm(temp, { recursive: true, force: true }).catch(() => {});
  }
}
