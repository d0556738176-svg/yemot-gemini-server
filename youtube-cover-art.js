// Cover picture for every song saved to Yemot: the video's own YouTube
// thumbnail, embedded in the WAV so a file downloaded from Yemot shows it.
//
// Where it goes: an "id3 " RIFF chunk AFTER the audio data (the standard
// place players read WAV tags from: Windows, VLC, foobar2000, MusicBee,
// Android players). Nothing is put BEFORE the audio: the header stays the
// canonical 44 bytes the phone line needs (measured earlier: an extra chunk
// before the audio was misread). The data chunk keeps its exact size, so a
// player that respects it never plays the picture.
import { promises as fs } from 'node:fs';
import { spawn } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';

const THUMBS = ['maxresdefault', 'sddefault', 'hqdefault', 'mqdefault'];

// Largest real thumbnail of the video (YouTube returns a small grey
// placeholder, not 404, for some missing sizes: those are skipped).
export async function fetchThumbnail(videoId, { fetchImpl = fetch, timeoutMs = 10000 } = {}) {
  if (!/^[A-Za-z0-9_-]{11}$/.test(String(videoId || ''))) return null;
  for (const name of THUMBS) {
    try {
      const r = await fetchImpl('https://i.ytimg.com/vi/' + videoId + '/' + name + '.jpg', { signal: AbortSignal.timeout(timeoutMs) });
      if (!r.ok) continue;
      const buf = Buffer.from(await r.arrayBuffer());
      if (buf.length > 2000 && buf[0] === 0xff && buf[1] === 0xd8) return { name, jpeg: buf };
    } catch { /* try the next size */ }
  }
  return null;
}

// 16:9 picture, at most 640x360, JPEG: the 4:3 sizes carry black bars, which
// are cropped away. Keeps the tag small (tens of KB).
export async function normalizeCover(jpeg, { ffmpegPath, timeoutMs = 30000, maxWidth = 640, quality = 4 } = {}) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'cover-'));
  try {
    const src = path.join(dir, 'in.jpg'), out = path.join(dir, 'out.jpg');
    await fs.writeFile(src, jpeg);
    const vf = "crop='if(gt(iw/ih,16/9),ih*16/9,iw)':'if(gt(iw/ih,16/9),ih,iw*9/16)',scale='min(" + Number(maxWidth) + ",iw)':-2";
    await new Promise((resolve, reject) => {
      const p = spawn(ffmpegPath, ['-hide_banner', '-loglevel', 'error', '-y', '-i', src, '-vf', vf, '-q:v', String(quality), '-frames:v', '1', out]);
      const t = setTimeout(() => p.kill('SIGKILL'), timeoutMs);
      p.on('error', reject);
      p.on('close', c => { clearTimeout(t); c === 0 ? resolve() : reject(new Error('cover ffmpeg failed (' + c + ')')); });
    });
    const b = await fs.readFile(out);
    return b.length > 1000 ? b : jpeg;
  } catch { return jpeg; } finally { await fs.rm(dir, { recursive: true, force: true }).catch(() => {}); }
}

// ID3v2.3 text frame (UTF-16 with BOM: Hebrew titles display correctly).
function textFrame(id, text) {
  const body = Buffer.concat([Buffer.from([1]), Buffer.from([0xff, 0xfe]), Buffer.from(String(text), 'utf16le')]);
  const h = Buffer.alloc(10); h.write(id, 0, 'latin1'); h.writeUInt32BE(body.length, 4);
  return Buffer.concat([h, body]);
}
function pictureFrame(jpeg) {
  const body = Buffer.concat([Buffer.from([0]), Buffer.from('image/jpeg\0', 'latin1'), Buffer.from([3]), Buffer.from([0]), jpeg]);
  const h = Buffer.alloc(10); h.write('APIC', 0, 'latin1'); h.writeUInt32BE(body.length, 4);
  return Buffer.concat([h, body]);
}
const synchsafe = n => Buffer.from([(n >> 21) & 0x7f, (n >> 14) & 0x7f, (n >> 7) & 0x7f, n & 0x7f]);

export function buildId3Tag({ title, artist, jpeg }) {
  const frames = [];
  if (title) frames.push(textFrame('TIT2', String(title).slice(0, 200)));
  if (artist) frames.push(textFrame('TPE1', String(artist).slice(0, 120)));
  if (jpeg) frames.push(pictureFrame(jpeg));
  const body = Buffer.concat(frames);
  return Buffer.concat([Buffer.from('ID3', 'latin1'), Buffer.from([3, 0, 0]), synchsafe(body.length), body]);
}

// Appends the tag as an "id3 " chunk after the audio and fixes the RIFF size.
// Refuses anything but a canonical 44-byte PCM WAV whose data chunk ends the
// file, so a song is never damaged: the caller then keeps the plain file.
export async function embedCoverInWav(wavPath, tag) {
  const fh = await fs.open(wavPath, 'r+');
  try {
    const { size } = await fh.stat();
    const head = Buffer.alloc(44);
    await fh.read(head, 0, 44, 0);
    if (head.toString('latin1', 0, 4) !== 'RIFF' || head.toString('latin1', 8, 12) !== 'WAVE' ||
        head.toString('latin1', 12, 16) !== 'fmt ' || head.toString('latin1', 36, 40) !== 'data') return false;
    const dataSize = head.readUInt32LE(40);
    if (44 + dataSize + (dataSize & 1) !== size) return false; // not canonical / already tagged
    const pad = tag.length & 1 ? Buffer.from([0]) : Buffer.alloc(0);
    const ch = Buffer.alloc(8); ch.write('id3 ', 0, 'latin1'); ch.writeUInt32LE(tag.length, 4);
    await fh.write(Buffer.concat([ch, tag, pad]), 0, 8 + tag.length + pad.length, size);
    const riff = Buffer.alloc(4); riff.writeUInt32LE(size + 8 + tag.length + pad.length - 8);
    await fh.write(riff, 0, 4, 4);
    return true;
  } finally { await fh.close(); }
}

// Everything in one call; never throws (a song without a picture is still a
// complete song).
export async function addCoverArt(wavPath, { videoId, title, artist, ffmpegPath, fetchImpl, log = console } = {}) {
  try {
    const thumb = await fetchThumbnail(videoId, { fetchImpl });
    if (!thumb) { log.info?.('[COVER] no thumbnail found', { videoId }); return false; }
    const jpeg = ffmpegPath ? await normalizeCover(thumb.jpeg, { ffmpegPath }) : thumb.jpeg;
    const ok = await embedCoverInWav(wavPath, buildId3Tag({ title, artist, jpeg }));
    log.info?.('[COVER] picture embedded', { videoId, ok, source: thumb.name, jpegBytes: jpeg.length });
    return ok;
  } catch (e) {
    log.warn?.('[COVER] picture not added', { videoId, message: String(e?.message || e).slice(0, 200) });
    return false;
  }
}

// Downloadable copy: the original (not phone-line) audio as MP3 with the
// picture as its front cover. Measured on the account 04.11: Yemot keeps such
// an MP3 byte for byte when uploaded without conversion.
export async function makeMp3WithCover(source, out, { jpeg, title, ffmpegPath, bitrate = '128k', timeoutMs = 3 * 3600 * 1000, signal } = {}) {
  const dir = path.dirname(out);
  const jpg = path.join(dir, 'cover.jpg');
  const args = ['-hide_banner', '-loglevel', 'error', '-y', '-i', source];
  if (jpeg) { await fs.writeFile(jpg, jpeg); args.push('-i', jpg, '-map', '0:a:0', '-map', '1:v:0', '-c:v', 'copy', '-disposition:v', 'attached_pic',
    '-metadata:s:v', 'title=Album cover', '-metadata:s:v', 'comment=Cover (front)'); }
  else args.push('-map', '0:a:0');
  args.push('-map_metadata', '-1', '-c:a', 'libmp3lame', '-b:a', bitrate, '-id3v2_version', '3');
  if (title) args.push('-metadata', 'title=' + String(title).slice(0, 200));
  args.push(out);
  await new Promise((resolve, reject) => {
    const p = spawn(ffmpegPath, args, { stdio: ['ignore', 'ignore', 'pipe'] });
    let err = '';
    p.stderr.on('data', d => { err = (err + d).slice(-400); });
    const t = setTimeout(() => p.kill('SIGKILL'), timeoutMs);
    const onAbort = () => p.kill('SIGKILL');
    signal?.addEventListener?.('abort', onAbort, { once: true });
    p.on('error', reject);
    p.on('close', c => { clearTimeout(t); signal?.removeEventListener?.('abort', onAbort); c === 0 ? resolve() : reject(new Error('mp3 ffmpeg failed (' + c + '): ' + err.trim())); });
  });
  await fs.rm(jpg, { force: true }).catch(() => {});
  return (await fs.stat(out)).size;
}

// YouTube category numbers -> genre names (the common ones).
const GENRES = { 1: 'Film & Animation', 2: 'Autos & Vehicles', 10: 'Music', 15: 'Pets & Animals', 17: 'Sports', 19: 'Travel & Events', 20: 'Gaming', 22: 'People & Blogs', 23: 'Comedy', 24: 'Entertainment', 25: 'News & Politics', 26: 'Howto & Style', 27: 'Education', 28: 'Science & Technology', 29: 'Nonprofits & Activism' };

export function publishedText(t) {
  const f = new Intl.DateTimeFormat('he-IL', { timeZone: 'Asia/Jerusalem', day: 'numeric', month: 'numeric', year: 'numeric', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
  const p = Object.fromEntries(f.formatToParts(new Date(t)).map(x => [x.type, x.value]));
  return 'פורסם ביוטיוב ב ' + p.day + '.' + p.month + '.' + p.year + ' בשעה ' + p.hour + ':' + p.minute + ' (שעון ישראל)';
}

// Every tag a player shows, from the YouTube video's own details.
export function downloadMetadata(videoId, facts = {}, fallbackTitle = null) {
  const url = 'https://www.youtube.com/watch?v=' + videoId;
  // The exact moment YouTube shows as the publish time, in Israel time.
  const t = Date.parse(facts.publishedAt || '');
  const published = Number.isFinite(t) ? publishedText(t) : '';
  const date = Number.isFinite(t) ? new Date(t).toISOString().replace('.000Z', 'Z') : '';
  const body = String(facts.description || '').replace(/\r/g, '').slice(0, 2000);
  const desc = [published, body].filter(Boolean).join('\n\n');
  const m = {
    title: facts.title || fallbackTitle || videoId,
    artist: facts.channel, album_artist: facts.channel, album: facts.channel,
    date: date || null,
    genre: GENRES[Number(facts.categoryId)] || null,
    comment: [published, url].filter(Boolean).join(' | '), description: desc || null, synopsis: desc || null,
    keywords: Array.isArray(facts.tags) && facts.tags.length ? facts.tags.join(', ').slice(0, 500) : null,
    copyright: facts.channel ? '© ' + facts.channel : null,
    publisher: 'YouTube', website: url, encoded_by: 'Yemot branch 2',
  };
  return Object.fromEntries(Object.entries(m).filter(([, v]) => v !== null && v !== undefined && v !== ''));
}

function runFfmpeg(ffmpegPath, args, { timeoutMs = 3 * 3600 * 1000, signal } = {}) {
  return new Promise((resolve, reject) => {
    const p = spawn(ffmpegPath, args, { stdio: ['ignore', 'ignore', 'pipe'] });
    let err = '';
    p.stderr.on('data', d => { err = (err + d).slice(-400); });
    const t = setTimeout(() => p.kill('SIGKILL'), timeoutMs);
    const onAbort = () => p.kill('SIGKILL');
    signal?.addEventListener?.('abort', onAbort, { once: true });
    p.on('error', reject);
    p.on('close', c => { clearTimeout(t); signal?.removeEventListener?.('abort', onAbort); c === 0 ? resolve() : reject(new Error('ffmpeg failed (' + c + '): ' + err.trim())); });
  });
}

// The downloadable song. m4a: YouTube's own AAC audio copied untouched (no
// re-encoding = no quality lost) with the picture and all tags; if the audio
// is not AAC it is encoded once at 256k. mp3: 320k (used only if Yemot would
// not keep an m4a intact).
export async function makeDownloadCopy(source, out, { format = 'm4a', jpeg, metadata = {}, ffmpegPath, signal, start = null, length = null } = {}) {
  const jpg = path.join(path.dirname(out), 'cover-' + path.basename(out) + '.jpg');
  const input = ['-hide_banner', '-loglevel', 'error', '-y', ...(start != null ? ['-ss', String(start)] : []), ...(length ? ['-t', String(length)] : []), '-i', source];
  const pic = [];
  if (jpeg) { await fs.writeFile(jpg, jpeg); input.push('-i', jpg); pic.push('-map', '1:v:0', '-disposition:v:0', 'attached_pic'); }
  const tags = ['-map_metadata', '-1'];
  for (const [k, v] of Object.entries(metadata)) tags.push('-metadata', k + '=' + String(v));
  try {
    if (format === 'flac') {
      // Lossless copy of the best stream: decoded once, kept bit-exact from
      // here on, 16-bit with triangular dither; picture and all tags.
      await runFfmpeg(ffmpegPath, [...input, '-map', '0:a:0', ...pic, '-c:v', 'copy', ...tags,
        '-af', 'aresample=osf=s16:dither_method=triangular', '-c:a', 'flac', '-compression_level', '8', out], { signal });
    } else if (format === 'm4a') {
      const base = [...input, '-map', '0:a:0', ...pic, '-c:v', 'copy', ...tags, '-movflags', '+faststart', '-f', 'ipod'];
      try { await runFfmpeg(ffmpegPath, [...base, '-c:a', 'copy', out], { signal }); }
      catch { await runFfmpeg(ffmpegPath, [...base, '-c:a', 'aac', '-b:a', '256k', out], { signal }); }
    } else {
      await runFfmpeg(ffmpegPath, [...input, '-map', '0:a:0', ...pic, '-c:v', 'copy', ...(jpeg ? ['-metadata:s:v', 'title=Album cover', '-metadata:s:v', 'comment=Cover (front)'] : []),
        ...tags, '-c:a', 'libmp3lame', '-b:a', '320k', '-id3v2_version', '3', out], { signal });
    }
  } finally { await fs.rm(jpg, { force: true }).catch(() => {}); }
  return (await fs.stat(out)).size;
}

// What a player will see in a file: its tags and whether it carries a picture
// (read with ffmpeg from the file itself, e.g. the copy read back from Yemot).
export async function inspectMedia(file, ffmpegPath) {
  const text = await new Promise(resolve => {
    const p = spawn(ffmpegPath, ['-hide_banner', '-i', file, '-f', 'ffmetadata', '-'], { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '', err = '';
    p.stdout.on('data', d => { out += d; }); p.stderr.on('data', d => { err += d; });
    p.on('close', () => resolve({ out, err })); p.on('error', () => resolve({ out: '', err: '' }));
  });
  const tags = {};
  for (const line of text.out.split('\n')) { const m = /^([a-z_]+)=(.*)$/i.exec(line); if (m) tags[m[1].toLowerCase()] = m[2]; }
  const picture = /Video: mjpeg[^\n]*\(attached pic\)|attached pic/.test(text.err);
  const pm = /Video: mjpeg[^\n]*?(\d{2,5})x(\d{2,5})/.exec(text.err);
  const am = /Audio: ([a-z0-9]+)[^\n]*?(\d+) Hz, ([a-z0-9.]+)(?:, ([a-z0-9]+))?(?:[^\n]*?(\d+) kb\/s)?/.exec(text.err);
  return { tags, picture, pictureSize: pm ? pm[1] + 'x' + pm[2] : null,
    audio: am ? { codec: am[1], hz: Number(am[2]), channels: am[3], sample: am[4] || null, kbps: am[5] ? Number(am[5]) : null } : null };
}

// A step that reaches YouTube is tried up to 3 times (2 s, then 6 s apart), so
// a slow moment never leaves a saved file without its picture or details.
export async function retrying(fn, { tries = 3, waits = [2000, 6000], ok = x => x != null } = {}) {
  let last = null;
  for (let i = 0; i < tries; i++) {
    try { last = await fn(); if (ok(last)) return last; } catch { last = null; }
    if (i < tries - 1) await new Promise(r => setTimeout(r, waits[i] ?? waits[waits.length - 1]));
  }
  return last;
}

// The picture for a saved file: YouTube's thumbnail, made 16:9; if shrinking
// fails the original picture is used rather than none.
export async function coverFor(videoId, { ffmpegPath, maxWidth = 1280, quality = 2, fetchThumbnailImpl = fetchThumbnail, normalize = normalizeCover } = {}) {
  const thumb = await retrying(() => fetchThumbnailImpl(videoId));
  if (!thumb?.jpeg) return null;
  try { return await normalize(thumb.jpeg, { ffmpegPath, maxWidth, quality }); } catch { return thumb.jpeg; }
}
