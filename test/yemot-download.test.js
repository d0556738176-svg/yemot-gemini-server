// Owner, 24.11: a recording always comes through, even when the package's
// login session expired (Yemot answers 500) or the file is still being written.
import test from 'node:test';
import assert from 'node:assert/strict';
import { robustDownload } from '../yemot-download.js';

const audio = Buffer.alloc(5000, 7);
const quiet = { info() {}, warn() {} };

test('the package works: its answer is used', async () => {
  const dl = robustDownload(async () => ({ data: audio }), { fetchImpl: async () => { throw new Error('not called'); }, log: quiet, waits: [0, 1, 1] });
  assert.equal((await dl('ivr2:/4/000.wav')).data.length, 5000);
});
test('expired session (HTTP 500): fetched straight from the API instead', async () => {
  let asked = '';
  const dl = robustDownload(async () => { throw Object.assign(new Error('Request failed with status code 500'), { response: { status: 500 } }); }, {
    fetchImpl: async url => { asked = String(url); return { ok: true, status: 200, arrayBuffer: async () => audio }; }, log: quiet, waits: [0, 1, 1] });
  const r = await dl('ivr2:/4/001.wav');
  assert.equal(r.data.length, 5000);
  assert.match(asked, /DownloadFile\?token=.*path=ivr2%3A%2F4%2F001.wav/);
});
test('not written yet: waits and tries again; an error text is never taken as audio', async () => {
  let n = 0;
  const dl = robustDownload(async () => { throw new Error('500'); }, {
    fetchImpl: async () => (++n < 2 ? { ok: true, status: 200, arrayBuffer: async () => Buffer.from('{"responseStatus":"ERROR"}') } : { ok: true, status: 200, arrayBuffer: async () => audio }), log: quiet, waits: [0, 1, 1] });
  assert.equal((await dl('ivr2:/4/002.wav')).data.length, 5000);
  assert.equal(n, 2);
});
