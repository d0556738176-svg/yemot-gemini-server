// One-off: fetch ytjar's official PHP sample from the Render server (open
// network) and print how it downloads media, so we can tell whether there is
// a proxied-download method we missed. Runs only when BRANCH2_INSPECT_SAMPLE=1.
// Parses the ZIP with Node's built-in zlib (no extra dependency).
import zlib from 'node:zlib';

const TAG = '[BRANCH2_SAMPLE_INSPECT]';
const SAMPLE_URL = 'https://www.ytjar.info/rapidapi/sample.zip';

function parseZip(buf) {
  const files = [];
  let i = 0;
  while (i + 30 <= buf.length) {
    if (buf.readUInt32LE(i) !== 0x04034b50) break; // local file header signature
    const method = buf.readUInt16LE(i + 8);
    const compSize = buf.readUInt32LE(i + 18);
    const nameLen = buf.readUInt16LE(i + 26);
    const extraLen = buf.readUInt16LE(i + 28);
    const name = buf.slice(i + 30, i + 30 + nameLen).toString('utf8');
    const dataStart = i + 30 + nameLen + extraLen;
    const data = buf.slice(dataStart, dataStart + compSize);
    let content = null;
    try {
      content = method === 0 ? data : method === 8 ? zlib.inflateRawSync(data) : null;
    } catch {}
    files.push({ name, method, size: compSize, content: content ? content.toString('utf8') : null });
    i = dataStart + compSize;
  }
  return files;
}

export async function runSampleInspect(env = process.env) {
  if (String(env.BRANCH2_INSPECT_SAMPLE || '').trim() !== '1') return;
  console.info(TAG, 'fetching sample');
  try {
    const r = await fetch(SAMPLE_URL, { headers: { 'user-agent': 'Mozilla/5.0' }, signal: AbortSignal.timeout(30000) });
    if (!r.ok) { console.warn(TAG, 'fetch failed', { httpStatus: r.status }); return; }
    const buf = Buffer.from(await r.arrayBuffer());
    console.info(TAG, 'downloaded', { bytes: buf.length });
    const files = parseZip(buf);
    console.info(TAG, 'files', files.map(f => f.name + '(' + f.size + ')').join(', ').slice(0, 400));
    for (const f of files) {
      if (!f.content || !/\.(php|txt|md|js|html?)$/i.test(f.name)) continue;
      // Print only the lines about downloading/endpoints, to keep logs short.
      const lines = f.content.split(/\r?\n/);
      const relevant = lines.filter(l => /curl|file_get_contents|fopen|http|rapidapi|\/dl|stream|download|mp3|audio|googlevideo|proxy|cgeo|CURLOPT|header/i.test(l));
      if (relevant.length) {
        console.info(TAG, 'FILE ' + f.name + ' (relevant lines):');
        for (const l of relevant.slice(0, 40)) console.info(TAG, '  | ' + l.trim().slice(0, 180));
      }
    }
    console.info(TAG, 'done');
  } catch (e) {
    console.warn(TAG, 'error', { message: String(e?.message || e).slice(0, 160) });
  }
}
