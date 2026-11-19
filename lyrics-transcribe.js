// The words of a saved song for its "lyrics" tag (owner, 19.11: the file in
// אודיו with the song's words in its details), when neither the uploader's
// description nor YouTube's captions gave them: the song's own audio is
// transcribed (Groq Whisper, free; Deepgram as backup) and laid out in lines.
// Marked as an automatic transcription. Up to 15 minutes of audio.
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';

function ffmpeg(bin, args) {
  return new Promise((resolve, reject) => {
    const p = spawn(bin, args, { stdio: ['ignore', 'ignore', 'pipe'] });
    let err = ''; p.stderr.on('data', d => { err = (err + d).slice(-300); });
    const t = setTimeout(() => p.kill('SIGKILL'), 10 * 60000);
    p.on('error', reject); p.on('close', c => { clearTimeout(t); c === 0 ? resolve() : reject(new Error('ffmpeg ' + c + ': ' + err)); });
  });
}

// Words with times -> lines: a new line after a pause, a sentence end, or 9 words.
export function wordsToLines(words) {
  const lines = []; let cur = [], last = null;
  for (const w of words || []) {
    const t = String(w.punctuated_word || w.word || '').trim();
    if (!t) continue;
    if (cur.length && ((last != null && Number(w.start) - last > 0.7) || cur.length >= 9)) { lines.push(cur.join(' ')); cur = []; }
    cur.push(t); last = Number(w.end);
    if (/[.!?…]$/.test(t)) { lines.push(cur.join(' ')); cur = []; }
  }
  if (cur.length) lines.push(cur.join(' '));
  // A line repeated many times in a row (Whisper on music) is kept once.
  return lines.filter((l, i) => !(i >= 2 && l === lines[i - 1] && l === lines[i - 2]));
}

export async function transcribedLyrics(source, { durationSec = null, ffmpegPath, env = process.env, log = console, transcribe = null } = {}) {
  if (Number(durationSec) > 15 * 60) return null;
  const small = source + '.lyrics.mp3';
  try {
    await ffmpeg(ffmpegPath, ['-hide_banner', '-loglevel', 'error', '-y', '-i', source, '-vn', '-ac', '1', '-ar', '16000', '-c:a', 'libmp3lame', '-b:a', '32k', small]);
    let r = null;
    if (transcribe) r = await transcribe(small);
    else {
      const sub = await import('./youtube-subtitles.js');
      r = await sub.whisperTimed(small, { env, log, mime: 'audio/mpeg' }).catch(() => null);
      if (!(r?.words?.length >= 20)) r = await sub.transcribeTimed(small, { env, log, mime: 'audio/mpeg' }).catch(() => null);
    }
    if (!(r?.words?.length >= 20)) return null;
    const lines = wordsToLines(r.words);
    if (lines.length < 3) return null;
    log.info?.('[DOWNLOADS] song words transcribed for the lyrics tag', { lines: lines.length, model: r.model || null });
    return (lines.join('\n') + '\n\n(תמלול אוטומטי של השמע)').slice(0, 20000);
  } finally { await fs.rm(small, { force: true }).catch(() => {}); }
}
