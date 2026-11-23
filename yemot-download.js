// Owner, 24.11: recordings must always come through. The yemot-api package
// logs in once; when that session expires Yemot answers DownloadFile with HTTP
// 500 (not the JSON "session expired" the package knows), so every recording
// failed until a restart ("I speak and it is not heard"). Here: the package
// first, then the stateless user:password token straight to the API, with a
// short wait and retry for a recording that is still being written.
import { yemotToken } from './song-ext7.js';

const API = 'https://www.call2all.co.il/ym/api';
const sleep = ms => new Promise(r => setTimeout(r, ms));

export function robustDownload(original, { fetchImpl = fetch, log = console, waits = [0, 700, 1800] } = {}) {
  return async function downloadFile(path) {
    let lastError;
    for (let i = 0; i < waits.length; i++) {
      if (waits[i]) await sleep(waits[i]);
      if (i === 0 && original) {
        try {
          const r = await original(path);
          if (r?.data && (r.data.length ?? r.data.byteLength ?? 1) > 0) return r;
        } catch (e) { lastError = e; }
      }
      try {
        const url = API + '/DownloadFile?' + new URLSearchParams({ token: yemotToken(), path });
        const r = await fetchImpl(url, { signal: AbortSignal.timeout(20000) });
        const buf = Buffer.from(await r.arrayBuffer());
        // An error comes back as a short JSON text, a recording as audio bytes.
        if (r.ok && buf.length > 200 && !/^\s*\{/.test(buf.subarray(0, 20).toString('utf8'))) {
          if (i > 0 || lastError) log.info?.('[YEMOT_DOWNLOAD] recording fetched directly', { attempt: i + 1, bytes: buf.length });
          return { data: buf, status: r.status };
        }
        lastError = new Error('DownloadFile HTTP ' + r.status + ' ' + buf.subarray(0, 120).toString('utf8').replace(/token=[^&\s"]+/g, ''));
      } catch (e) { lastError = e; }
    }
    log.warn?.('[YEMOT_DOWNLOAD] recording could not be fetched', { path: String(path).slice(0, 60), message: String(lastError?.message || lastError).slice(0, 160) });
    throw lastError || new Error('recording download failed');
  };
}
