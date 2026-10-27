import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { downloadVerified } from '../verified-download.mjs';

const data = Buffer.from(Array.from({length: 101}, (_, i) => i));
async function run(mode, fn) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'range-test-'));
  const dest = path.join(dir, 'audio');
  let count = 0;
  const server = http.createServer((req, res) => {
    count++;
    const m = /^bytes=(\d+)-(\d+)$/.exec(req.headers.range || '');
    if (!m) return res.writeHead(400).end();
    const start = +m[1], end = Math.min(+m[2], data.length - 1);
    if (mode === 'ignore') return res.writeHead(200).end(data);
    let tag = mode === 'change' && count > 1 ? '"v2"' : '"v1"';
    const body = data.subarray(start,end+1);
    res.writeHead(206, {'Content-Range': `bytes ${start}-${end}/${data.length}`, 'ETag': tag});
    res.end(mode === 'short' ? body.subarray(0, 2) : body);
  });
  await new Promise(resolve => server.listen(0,'127.0.0.1',resolve));
  try { await fn(`http://127.0.0.1:${server.address().port}/audio`,dest); }
  finally { await new Promise(resolve=>server.close(resolve)); await rm(dir,{recursive:true,force:true}); }
}
test('downloads a complete source with verified ranges', async()=>run('ok', async(url,dest)=>{
  const result=await downloadVerified(url,dest,{chunkBytes:20});
  assert.equal(result.bytes,data.length);
  assert.deepEqual(await readFile(dest),data);
}));
for (const mode of ['ignore','short','change']) test('rejects '+mode+' and removes partial file',async()=>run(mode,async(url,dest)=>{
  await assert.rejects(downloadVerified(url,dest,{chunkBytes:20}));
  await assert.rejects(stat(dest),{code:'ENOENT'});
}));
test('rejects source exceeding maximum size',async()=>run('ok',async(url,dest)=>{
  await assert.rejects(downloadVerified(url,dest,{chunkBytes:20,maxBytes:50}));
  await assert.rejects(stat(dest),{code:'ENOENT'});
}));
