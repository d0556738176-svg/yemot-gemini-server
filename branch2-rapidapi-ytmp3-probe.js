// Isolated probe for the youtube-mp3-download3 RapidAPI service as a possible
// FREE backup download source. Gated by BRANCH2_YTMP3_PROBE=1; it NEVER touches
// the branch 2 playback flow. It calls the convert endpoint, logs the response
// shape (key always redacted), finds the download URL, and fetches it to prove
// the file is a real audio our server can pull (and that it is NOT a googlevideo
// link, which would be IP-locked and useless from a server).
const TAG = '[BRANCH2_YTMP3_PROBE]';
const HOST = 'youtube-mp3-download3.p.rapidapi.com';

function redact(text, key) {
  let t = String(text || '');
  if (key) t = t.split(key).join('[redacted]');
  return t;
}

export async function runYtMp3Probe(env = process.env) {
  if (String(env.BRANCH2_YTMP3_PROBE || '').trim() !== '1') return;
  const key = String(env.RAPIDAPI_YTMP3_KEY || '').trim();
  if (!key) { console.warn(TAG, 'RAPIDAPI_YTMP3_KEY not set'); return; }
  const videoId = String(env.BRANCH2_YTMP3_PROBE_VIDEO || 'CzlPOmQBEuk');
  const watch = 'https://www.youtube.com/watch?v=' + videoId;
  const url = 'https://' + HOST + '/downloads/convert_audio?url=' + encodeURIComponent(watch) + '&format=mp3';
  const headers = { 'x-rapidapi-host': HOST, 'x-rapidapi-key': key };
  console.info(TAG, 'start', { videoId });
  try {
    const t0 = Date.now();
    const r = await fetch(url, { headers, signal: AbortSignal.timeout(90000) });
    const ct = String(r.headers.get('content-type') || '').toLowerCase();
    console.info(TAG, 'response', { httpStatus: r.status, contentType: ct, ms: Date.now() - t0 });

    // Case A: the endpoint streams the audio file directly.
    if (ct.includes('audio') || ct.includes('octet-stream')) {
      const buf = Buffer.from(await r.arrayBuffer());
      console.info(TAG, 'summary', JSON.stringify({ works: r.ok && buf.length > 50000, directFile: true, bytes: buf.length }));
      return;
    }

    // Case B: JSON/text with a download URL (possibly after a processing step).
    const text = await r.text();
    let body = null; try { body = JSON.parse(text); } catch {}
    if (!body || typeof body !== 'object') {
      console.info(TAG, 'non-json body', redact(text.slice(0, 400), key));
      console.info(TAG, 'summary', JSON.stringify({ works: false, reason: 'non_json_response', httpStatus: r.status }));
      return;
    }
    console.info(TAG, 'json keys', Object.keys(body).slice(0, 25).join(','));
    console.info(TAG, 'json body', redact(JSON.stringify(body).slice(0, 900), key));

    const urls = (JSON.stringify(body).match(/https?:\/\/[^"'\\ ]+/g) || []);
    const dl = urls.find(u => /\.(mp3|m4a|webm|ogg|aac)(\?|$)/i.test(u))
      || urls.find(u => /download|dl|file|audio|cdn|stream/i.test(u))
      || null;
    if (!dl) {
      console.info(TAG, 'summary', JSON.stringify({ works: false, reason: 'no_download_url', note: 'response may need a status/progress poll step', status: body.status || body.state || null }));
      return;
    }
    const dlHost = new URL(dl).hostname;
    console.info(TAG, 'download url host', { host: dlHost, isGooglevideo: /googlevideo/.test(dlHost) });

    // Fetch the file to confirm it is really downloadable from a server.
    try {
      const d0 = Date.now();
      const fHeaders = /rapidapi/.test(dlHost) ? headers : {};
      const fr = await fetch(dl, { headers: fHeaders, signal: AbortSignal.timeout(90000) });
      const fct = String(fr.headers.get('content-type') || '').toLowerCase();
      let bytes = 0;
      if (fr.ok && fr.body) bytes = Buffer.from(await fr.arrayBuffer()).length;
      const looksAudio = /audio|octet-stream|mpeg|mp3/.test(fct) || bytes > 100000;
      console.info(TAG, 'file fetch', { httpStatus: fr.status, contentType: fct, bytes, ms: Date.now() - d0, looksAudio });
      console.info(TAG, 'summary', JSON.stringify({
        works: fr.ok && looksAudio && !/googlevideo/.test(dlHost),
        downloadHost: dlHost, isGooglevideo: /googlevideo/.test(dlHost), bytes
      }));
    } catch (fe) {
      console.warn(TAG, 'file fetch failed', { message: redact(String(fe?.message || fe), key).slice(0, 150) });
      console.info(TAG, 'summary', JSON.stringify({ works: false, reason: 'file_fetch_failed', downloadHost: dlHost }));
    }
  } catch (e) {
    console.warn(TAG, 'error', { message: redact(String(e?.message || e), key).slice(0, 180) });
    console.info(TAG, 'summary', JSON.stringify({ works: false, reason: 'request_failed' }));
  }
}
