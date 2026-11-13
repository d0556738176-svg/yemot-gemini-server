// Every finished extension-4 song is also saved to extension 7 ("the new
// songs", newest first), next to the songs extension 2 downloads.
//
// Extension 7 is a Yemot playfile folder that plays the highest number first;
// the extension-2 service keeps the numbering in ivr2:/2/youtubeaudio/
// ext7_index.json ({ version, next, items: { key: { file, title, at } } }).
// This module follows exactly the same protocol (reserve the number first,
// then upload, then list), so both services share one numbering.
const API = 'https://www.call2all.co.il/ym/api';
const INDEX = 'ivr2:/2/youtubeaudio/ext7_index.json';
let chain = Promise.resolve();

export function yemotToken() {
  const direct = String(process.env.YEMOT_API_KEY || process.env.YEMOT_TOKEN || '').trim();
  if (direct) return direct;
  const u = String(process.env.YEMOT_API_USERNAME || '').trim(), p = String(process.env.YEMOT_API_PASSWORD || '').trim();
  return u && p ? u + ':' + p : '';
}

async function readIndex() {
  const meta = await fetch(API + '/GetFile?' + new URLSearchParams({ token: yemotToken(), what: INDEX }), { signal: AbortSignal.timeout(10000) })
    .then(r => r.json()).catch(() => null);
  if (meta?.responseStatus === 'OK' && meta?.file?.exists === false) return null;
  if (meta?.responseStatus !== 'OK') {
    if (/not.?found|not.?exist|לא קיים|לא נמצא/i.test(String(meta?.message || ''))) return null;
    throw new Error('Extension 7 index is not readable right now');
  }
  const r = await fetch(API + '/DownloadFile?' + new URLSearchParams({ token: yemotToken(), path: INDEX }), { signal: AbortSignal.timeout(10000) });
  if (!r.ok) throw new Error('Extension 7 index download HTTP ' + r.status);
  return JSON.parse(await r.text());
}

async function writeIndex(data) {
  const url = new URL(API + '/UploadFile');
  url.searchParams.set('token', yemotToken());
  url.searchParams.set('path', INDEX);
  url.searchParams.set('convertAudio', '0');
  url.searchParams.set('autoNumbering', 'false');
  const form = new FormData();
  form.append('file', new Blob([JSON.stringify(data)], { type: 'application/json' }), 'ext7_index.json');
  const r = await fetch(url, { method: 'POST', body: form, signal: AbortSignal.timeout(20000) });
  const j = await r.json().catch(() => null);
  if (!r.ok || j?.responseStatus !== 'OK') throw new Error('Extension 7 index write failed');
}

async function uploadWav(buffer, remotePath) {
  const url = new URL(API + '/UploadFile');
  url.searchParams.set('token', yemotToken());
  url.searchParams.set('path', remotePath);
  url.searchParams.set('convertAudio', '1');
  url.searchParams.set('autoNumbering', 'false');
  const form = new FormData();
  form.append('file', new Blob([buffer], { type: 'audio/wav' }), 'song.wav');
  const r = await fetch(url, { method: 'POST', body: form, signal: AbortSignal.timeout(Math.max(30000, Math.ceil(buffer.length / 200000) * 1000)) });
  const j = await r.json().catch(() => null);
  if (!r.ok || (j?.responseStatus && j.responseStatus !== 'OK') || j?.success === false) {
    throw new Error('Extension 7 upload failed: ' + String(j?.message || r.status).slice(0, 120));
  }
}

export function ext7FileName(n) { return String(n).padStart(3, '0'); }

// key: unique id of the song (listed once); wav: one full 8kHz mono WAV.
export function publishSongToExt7(key, wav, title, { log = console } = {}) {
  const job = chain.then(async () => {
    if (!yemotToken()) throw new Error('Yemot credentials are missing');
    const index = (await readIndex()) || { version: 1, next: 0, items: {} };
    if (index.items?.[key]) return index.items[key];
    const n = Number.isInteger(index.next) && index.next >= 0 ? index.next : 0;
    if (n > 999) throw new Error('Extension 7 is full (1000 files)');
    const file = ext7FileName(n);
    const entry = { file, title: String(title || '').slice(0, 120), at: new Date().toISOString(), source: 'ext4-ai-song' };
    const items = { ...(index.items || {}) };
    // Reserve the number before uploading (same rule as extension 2): a
    // failure leaves a harmless gap, never two songs on one number.
    await writeIndex({ ...index, version: 1, next: n + 1, items });
    await uploadWav(wav, 'ivr2:/7/' + file + '.wav');
    // Re-read so an entry extension 2 added meanwhile is kept.
    const latest = (await readIndex().catch(() => null)) || { version: 1, next: n + 1, items };
    await writeIndex({ ...latest, version: 1, next: Math.max(Number(latest.next) || 0, n + 1), items: { ...(latest.items || {}), [key]: entry } });
    log.info?.('[SONG] EXT7_ADDED', { key, file });
    return entry;
  });
  chain = job.catch(() => {});
  return job;
}
