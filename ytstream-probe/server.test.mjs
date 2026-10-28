import test from 'node:test';
import assert from 'node:assert/strict';
import { safeMediaUrl, isAudio, makeServer } from './server.mjs';
test('HTML returned with HTTP 200 or an audio mime is never accepted', () => {
  const b=Buffer.from('<html><h1>Site Unavailable</h1></html>');
  assert.equal(isAudio(b,'text/html'),false);
  assert.equal(isAudio(b,'audio/mp4'),false);
  assert.equal(isAudio(Buffer.from('{}'),'application/json'),false);
});
test('recognizes MP4 and WebM headers', () => {
  assert.equal(isAudio(Buffer.from([0,0,0,24,102,116,121,112]),'audio/mp4'),true);
  assert.equal(isAudio(Buffer.from([0x1a,0x45,0xdf,0xa3]),'audio/webm'),true);
});
test('media redirects cannot forward credentials or reach arbitrary hosts', () => {
  assert.equal(safeMediaUrl('https://redirector.googlevideo.com/videoplayback').hostname,'redirector.googlevideo.com');
  for(const u of ['http://googlevideo.com/x','https://googlevideo.com.evil.test/x','https://localhost/x','https://user:pw@x.googlevideo.com/x']) {
    assert.throws(()=>safeMediaUrl(u));
  }
});
test('public health is side-effect free and probe is authenticated', async () => {
  process.env.PROBE_SECRET='unit-test-secret';
  const s=makeServer(); await new Promise(r=>s.listen(0,'127.0.0.1',r));
  try {
    const base='http://127.0.0.1:'+s.address().port;
    assert.equal((await fetch(base+'/health')).status,200);
    assert.equal((await fetch(base+'/probe',{method:'POST'})).status,403);
    const r=await fetch(base+'/result',{headers:{'x-probe-secret':'unit-test-secret'}});
    assert.deepEqual(await r.json(),{running:false,result:null});
  } finally { await new Promise(r=>s.close(r)); }
});
