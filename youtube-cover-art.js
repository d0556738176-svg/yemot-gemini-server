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
export async function normalizeCover(jpeg, { ffmpegPath, timeoutMs = 30000 } = {}) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'cover-'));
  try {
    const src = path.join(dir, 'in.jpg'), out = path.join(dir, 'out.jpg');
    await fs.writeFile(src, jpeg);
    const vf = "crop='if(gt(iw/ih,16/9),ih*16/9,iw)':'if(gt(iw/ih,16/9),ih,iw*9/16)',scale='min(640,iw)':-2";
    await new Promise((resolve, reject) => {
      const p = spawn(ffmpegPath, ['-hide_banner', '-loglevel', 'error', '-y', '-i', src, '-vf', vf, '-q:v', '4', '-frames:v', '1', out]);
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
