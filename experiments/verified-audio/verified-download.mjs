import { open, rm } from 'node:fs/promises';

// Only for sources whose server implements standard HTTP byte ranges.
export async function downloadVerified(url, destination, { maxBytes = 32 * 1024 * 1024, chunkBytes = 256 * 1024, fetchImpl = fetch } = {}) {
  if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0 || !Number.isSafeInteger(chunkBytes) || chunkBytes <= 0) throw new Error('Invalid limits');
  const file = await open(destination, 'wx');
  let offset = 0, total = null, etag = null;
  try {
    while (total === null || offset < total) {
      const end = Math.min(offset + chunkBytes - 1, maxBytes - 1);
      const headers = { Range: `bytes=${offset}-${end}`, 'Accept-Encoding': 'identity' };
      if (etag) headers['If-Range'] = etag;
      const response = await fetchImpl(url, { headers, redirect: 'error', signal: AbortSignal.timeout(15000) });
      if (response.status !== 206) throw new Error('Source did not honor byte range');
      if (response.headers.get('content-encoding') && response.headers.get('content-encoding') !== 'identity') throw new Error('Encoded range response');
      const m = /^bytes (\d+)-(\d+)\/(\d+)$/.exec(response.headers.get('content-range') || '');
      if (!m) throw new Error('Invalid Content-Range');
      const [start, last, size] = m.slice(1).map(Number);
      if (![start, last, size].every(Number.isSafeInteger) || start !== offset || last !== Math.min(end, size - 1) || size <= 0 || size > maxBytes || (total !== null && size !== total)) throw new Error('Inconsistent byte range');
      const currentEtag = response.headers.get('etag');
      if (offset && (!etag || !currentEtag || currentEtag !== etag)) throw new Error('Source identity cannot be verified');
      if (!offset) etag = currentEtag && !currentEtag.startsWith('W/') ? currentEtag : null;
      total = size;
      const expected = last - start + 1;
      const len = response.headers.get('content-length');
      if (len !== null && Number(len) !== expected) throw new Error('Incorrect Content-Length');
      if (!response.body) throw new Error('Missing response body');
      const reader = response.body.getReader();
      let got = 0;
      try {
        for (;;) {
          const {done, value} = await reader.read();
          if (done) break;
          got += value.byteLength;
          if (got > expected) throw new Error('Oversized response');
          let written = 0;
          while (written < value.byteLength) {
            const result = await file.write(value, written, value.byteLength - written);
            if (!result.bytesWritten) throw new Error('Write failed');
            written += result.bytesWritten;
          }
        }
      } finally { reader.releaseLock(); }
      if (got !== expected) throw new Error('Truncated response');
      offset += got;
    }
    await file.close();
    return {bytes: offset};
  } catch (error) {
    await file.close().catch(() => {});
    await rm(destination, {force:true}).catch(() => {});
    throw error;
  }
}
