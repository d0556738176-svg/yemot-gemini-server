// Real FFmpeg and a real local HTTP range server; Yemot and calls are simulated.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import ffmpegPath from 'ffmpeg-static';
import { prepareSegment, startRangeCountingProxy, extractSegment, wavFacts, SEGMENT_SECONDS, _activeSegmentJobs } from '../segmented-audio.js';
import { playSegmented } from '../segmented-player.js';

const keepAlive = setInterval(() => {}, 1000);
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'segtest-'));
const servers = [];
after(() => { clearInterval(keepAlive); servers.forEach(s => s.close()); fs.rmSync(dir, { recursive: true, force: true }); });
const skip = !ffmpegPath || !fs.existsSync(ffmpegPath);

function makeSource(name, seconds) {
  const out = path.join(dir, name);
  execFileSync(ffmpegPath, ['-v', 'error', '-f', 'lavfi', '-i', `aevalsrc='0.4*sin(2*PI*(300+40*mod(floor(t/10),12))*t)':s=44100:d=${seconds}`,
    '-c:a', 'aac', '-b:a', '64k', '-movflags', '+frag_keyframe+empty_moov+default_base_moof+global_sidx', '-frag_duration', '5000000', '-y', out]);
  return out;
}
function serve(file, { failAfter = Infinity } = {}) {
  let n = 0;
  return new Promise(r => {
    const s = http.createServer((q, res) => {
      if (++n > failAfter) { res.writeHead(503); return res.end(); }
      const size = fs.statSync(file).size; const m = /bytes=(\d+)-(\d*)/.exec(q.headers.range || '');
      const a = m ? +m[1] : 0, b = m && m[2] ? Math.min(+m[2], size - 1) : size - 1;
      res.writeHead(m ? 206 : 200, { 'content-length': b - a + 1, 'accept-ranges': 'bytes', ...(m ? { 'content-range': `bytes ${a}-${b}/${size}` } : {}) });
      fs.createReadStream(file, { start: a, end: b }).pipe(res);
    });
    servers.push(s);
    s.listen(0, '127.0.0.1', () => r('http://127.0.0.1:' + s.address().port + '/a.m4a'));
  });
}
function fakeYemot() {
  const files = new Map(); let uploads = 0;
  return {
    files, get uploads() { return uploads; },
    isReady: async remote => files.has(remote) ? { ready: true, durationSec: files.get(remote) } : { ready: false },
    verify: async remote => files.has(remote) ? { ready: true, durationSec: files.get(remote) } : { ready: false },
    upload: async (file, remote) => { uploads++; files.set(remote, (await wavFacts(file)).durationSec); }
  };
}
const quiet = { info() {}, warn() {} };

test('long source: 3 segments of 180/180/90 s, partial download per segment', { skip }, async () => {
  const src = makeSource('long.m4a', 450); const url = await serve(src); const yemot = fakeYemot();
  const total = fs.statSync(src).size; const results = [];
  for (let i = 0; i < 3; i++) {
    const h = prepareSegment('long', i, { resolveSourceUrl: async () => url, yemot, log: quiet });
    results.push(await h.promise); h.release();
  }
  assert.deepEqual(results.map(r => Math.round(r.durationSec)), [180, 180, 90]);
  assert.deepEqual(results.map(r => r.isLast), [false, false, true]);
  assert.ok(results[2].bytesFetched < total * 0.5, 'last segment fetched only part of the file: ' + results[2].bytesFetched + '/' + total);
  assert.deepEqual(results.map(r => r.playPath), ['/2/yts/s180v1/long-001', '/2/yts/s180v1/long-002', '/2/yts/s180v1/long-003']);
});

test('short source (70 s) is a single last segment', { skip }, async () => {
  const url = await serve(makeSource('short.m4a', 70)); const yemot = fakeYemot();
  const h = prepareSegment('short', 0, { resolveSourceUrl: async () => url, yemot, log: quiet });
  const r = await h.promise; h.release();
  assert.equal(Math.round(r.durationSec), 70); assert.equal(r.isLast, true);
});

test('two calls share one preparation; second ask is served from cache', { skip }, async () => {
  const url = await serve(makeSource('shared.m4a', 200)); const yemot = fakeYemot();
  const deps = { resolveSourceUrl: async () => url, yemot, log: quiet };
  const a = prepareSegment('shared', 0, deps), b = prepareSegment('shared', 0, deps);
  const [ra, rb] = await Promise.all([a.promise, b.promise]); a.release(); b.release();
  assert.equal(yemot.uploads, 1); assert.equal(ra, rb);
  const c = prepareSegment('shared', 0, deps); const rc = await c.promise; c.release();
  assert.equal(rc.cached, true); assert.equal(rc.bytesFetched, 0); assert.equal(yemot.uploads, 1);
});

test('last listener leaving cancels unfinished work', { skip }, async () => {
  const url = await serve(makeSource('cancel.m4a', 450)); const yemot = fakeYemot();
  const h = prepareSegment('cancel', 1, { resolveSourceUrl: async () => { await new Promise(r => setTimeout(r, 300)); return url; }, yemot, log: quiet });
  h.release();
  await assert.rejects(h.promise);
  assert.equal(yemot.uploads, 0); assert.equal(_activeSegmentJobs(), 0);
});

function fakeCall(script) {
  const reads = [];
  return { reads, read: async (msgs, mode, opts) => { reads.push({ msgs, mode, opts }); const step = script.shift(); if (step instanceof Error) throw step; return step ?? ''; } };
}

test('call plays segments in order, each via a new request, prefetching the next', { skip }, async () => {
  const url = await serve(makeSource('call.m4a', 450)); const yemot = fakeYemot();
  const call = fakeCall(['', '', '']);
  const status = await playSegmented(call, { sourceKey: 'call', resolveSourceUrl: async () => url, log: quiet, yemot });
  assert.equal(status, 'ההשמעה הסתיימה.');
  assert.deepEqual(call.reads.map(r => r.msgs[0].data), ['/2/yts/s180v1/call-001', '/2/yts/s180v1/call-002', '/2/yts/s180v1/call-003']);
  assert.ok(call.reads.every(r => r.mode === 'tap' && r.opts.allow_empty === true));
});

test('caller pressing 9 stops; hang-up propagates and releases prefetch', { skip }, async () => {
  const url = await serve(makeSource('stop.m4a', 450));
  const stop = fakeCall(['9']); const yemot = fakeYemot();
  assert.equal(await playSegmented(stop, { sourceKey: 'stop', resolveSourceUrl: async () => url, log: quiet, yemot }), 'ההשמעה הופסקה.');
  const hang = fakeCall([new Error('the call was hangup by the caller')]);
  await assert.rejects(playSegmented(hang, { sourceKey: 'hang', resolveSourceUrl: async () => url, log: quiet, yemot }), /hangup/);
  await new Promise(r => setTimeout(r, 300));
  assert.equal(_activeSegmentJobs(), 0, 'no orphan preparation after hang-up');
});

test('failure preparing the continuation gives a clear message, not a missing path', { skip }, async () => {
  const src = makeSource('fail.m4a', 450);
  const url = await serve(src, { failAfter: 12 }); // enough for segment 1 only
  const call = fakeCall(['', '', '', '', '']); const yemot = fakeYemot();
  const status = await playSegmented(call, { sourceKey: 'fail', resolveSourceUrl: async () => url, log: quiet, yemot });
  assert.match(status, /לא הצלחתי|לא הוכן/);
  assert.equal(call.reads.filter(r => r.msgs[0].type === 'file').length, 1, 'only the ready segment was played');
});
