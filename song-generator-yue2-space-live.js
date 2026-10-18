import { Buffer } from 'node:buffer';
import { writeFile } from 'node:fs/promises';

const SPACE_URL = 'https://mrfakename-yue2-3b.hf.space';
const MAX_AUDIO_BYTES = 35 * 1024 * 1024;
const TIMEOUT_MS = 330000;

function headers(json = false) {
  const token = String(process.env.HF_TOKEN || '').trim();
  return {
    ...(token ? { authorization: 'Bearer ' + token } : {}),
    ...(json ? { 'content-type': 'application/json' } : {})
  };
}

async function fetchWithTimeout(url, options, timeoutMs, label) {
  let response;
  try {
    response = await fetch(url, { ...options, signal: AbortSignal.timeout(timeoutMs) });
  } catch (error) {
    throw new Error(label + ' network/timeout failure (' +
      (error?.name === 'TimeoutError' || error?.name === 'AbortError' ? 'timeout' : 'network') + ')');
  }
  if (!response.ok) {
    const body = (await response.text().catch(() => '')).replace(/Bearer\s+\S+/gi, 'Bearer [redacted]');
    throw new Error(label + ' HTTP ' + response.status + ': ' + body.slice(0, 220));
  }
  return response;
}

function parseEventStream(body) {
  let event = '';
  let data = '';
  const seen = [];
  for (const line of String(body || '').split(/\r?\n/)) {
    if (line.startsWith('event:')) {
      event = line.slice(6).trim();
      if (event && !seen.includes(event)) seen.push(event);
    } else if (line.startsWith('data:')) {
      data = line.slice(5).trim();
    }
    if (!data) continue;
    if (event === 'error') {
      throw new Error('YuE2 Space returned a Gradio error event: ' + data.slice(0, 180));
    }
    if (event === 'complete') {
      try { return JSON.parse(data); }
      catch { throw new Error('YuE2 Space completion event was not valid JSON'); }
    }
  }
  throw new Error('YuE2 Space did not complete generation; events=' + seen.join(','));
}

function findAudioFile(value, depth = 0) {
  if (depth > 10 || value == null) return null;
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = findAudioFile(item, depth + 1);
      if (found) return found;
    }
    return null;
  }
  if (typeof value === 'object') {
    const url = typeof value.url === 'string' ? value.url : '';
    const path = typeof value.path === 'string' ? value.path : '';
    const mime = String(value.mime_type || value.mimeType || '').toLowerCase();
    const name = String(value.orig_name || value.name || value.path || value.url || '').toLowerCase();
    if ((url || path) && (mime.includes('audio') || /\.(mp3|wav|flac)(?:[?#]|$)/i.test(name) || depth < 3)) {
      return { url, path, mime };
    }
    for (const child of Object.values(value)) {
      const found = findAudioFile(child, depth + 1);
      if (found) return found;
    }
  }
  return null;
}

async function readAudio(response) {
  const declared = Number(response.headers.get('content-length') || 0);
  if (declared > MAX_AUDIO_BYTES) throw new Error('Generated audio exceeds size limit');
  const bytes = Buffer.from(await response.arrayBuffer());
  if (!bytes.length || bytes.length > MAX_AUDIO_BYTES) throw new Error('Generated audio is empty or too large');
  const id3 = bytes.subarray(0, 3).toString('ascii') === 'ID3';
  const mpeg = bytes.length > 1 && bytes[0] === 0xff && (bytes[1] & 0xe0) === 0xe0;
  if (!id3 && !mpeg) throw new Error('Generated file did not have a valid MP3 header');
  if (bytes.length < 10000) throw new Error('Generated MP3 is unexpectedly short');
  return bytes;
}

if (!String(process.env.HF_TOKEN || '').trim()) {
  throw new Error('HF_TOKEN GitHub Secret is required for the free Hugging Face Space test');
}

try {
  const base = new URL(SPACE_URL);
  const infoResponse = await fetchWithTimeout(new URL('/gradio_api/info', base), {
    headers: headers()
  }, 15000, 'YuE2 Space schema');
  const info = await infoResponse.json();
  const endpoint = info?.named_endpoints?.['/generate_song'] || info?.named_endpoints?.generate_song;
  if (!endpoint || !Array.isArray(endpoint.parameters)) {
    throw new Error('YuE2 Space did not expose the documented /generate_song endpoint');
  }
  const parameters = endpoint.parameters;
  console.log('YUE2_SCHEMA_OK', JSON.stringify({
    endpoint: '/generate_song',
    parameterCount: parameters.length,
    labels: parameters.map(p => String(p.label || p.parameter_name || p.name || '')).slice(0, 8)
  }));

  // The public Space's documented generate_song signature is:
  // style, lyrics, planning_mode, render_quality, seed.
  const submitResponse = await fetchWithTimeout(new URL('/gradio_api/call/generate_song', base), {
    method: 'POST',
    headers: headers(true),
    body: JSON.stringify({
      data: [
        'Hebrew-language upbeat Israeli pop, clear lead vocal singing in Hebrew, modern synths, punchy drums, warm bass, catchy melody',
        '[Verse]\nנוסעים קדימה, האור נדלק\nקצב בלב וכל רגע מתחזק\n\n[Chorus]\nעוד צעד ועוד חלום\nשרים ביחד עד סוף היום',
        'full',
        16,
        42
      ]
    })
  }, 30000, 'YuE2 generation submission');
  const submission = await submitResponse.json();
  const eventId = String(submission?.event_id || '').trim();
  if (!eventId) throw new Error('YuE2 Space did not return a Gradio event ID');

  const resultResponse = await fetchWithTimeout(
    new URL('/gradio_api/call/generate_song/' + encodeURIComponent(eventId), base),
    { headers: headers() },
    TIMEOUT_MS,
    'YuE2 song generation'
  );
  const outputs = parseEventStream(await resultResponse.text());
  const file = findAudioFile(outputs);
  if (!file) throw new Error('YuE2 generation completed without an audio file object');

  let audioUrl;
  if (file.url) audioUrl = new URL(file.url, base);
  else if (file.path) audioUrl = new URL('/gradio_api/file=' + file.path, base);
  else throw new Error('YuE2 returned an invalid audio file reference');
  if (audioUrl.protocol !== 'https:') throw new Error('YuE2 returned a non-HTTPS audio URL');

  // Never forward the Hugging Face token to a different host.
  const downloadHeaders = audioUrl.origin === base.origin ? headers() : {};
  const audioResponse = await fetchWithTimeout(audioUrl, { headers: downloadHeaders }, 30000, 'YuE2 audio download');
  const audio = await readAudio(audioResponse);
  const outputPath = 'branch4-yue2-hebrew-test.mp3';
  await writeFile(outputPath, audio);
  console.log('LIVE_YUE2_MUSIC_TEST_OK', JSON.stringify({
    provider: 'huggingface-yue2-space',
    model: 'm-a-p/YuE2-3B',
    bytes: audio.length,
    mp3HeaderValid: true,
    outputPath,
    languageStatus: 'Hebrew pronunciation must be manually listened to; model UI officially lists other languages'
  }));
} catch (error) {
  console.error('LIVE_YUE2_MUSIC_TEST_FAILED', String(error?.message || error).slice(0, 500));
  process.exitCode = 1;
}
