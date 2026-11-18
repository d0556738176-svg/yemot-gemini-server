import test from 'node:test';
import assert from 'node:assert/strict';
import { searchWebVideos } from '../web-video-search.js';

test('merges video and web results from every site, videos first, no duplicates or documents', async () => {
  const fetchImpl = async (url, opts) => {
    const body = JSON.parse(opts.body || '{}');
    if (url.endsWith('/videos')) return { ok: true, status: 200, json: async () => ({ videos: [
      { link: 'https://www.hidabroot.org/video/1', title: 'שיעור - הידברות', duration: '1:36:49' },
      { link: 'https://www.youtube.com/watch?v=abcdefghijk', title: 'שיעור - YouTube' }] }) };
    if (url.endsWith('/search')) return { ok: true, status: 200, json: async () => ({ organic: [
      { link: 'https://www.hidabroot.org/video/1?utm_source=test', title: 'כפול' },
      { link: 'https://example.org/file.pdf', title: 'מסמך' },
      { link: 'https://torah.example/shiur/5', title: 'שיעור ' + (body.q.includes('וידאו') ? 'וידאו' : 'רגיל') }] }) };
    return { ok: false, status: 404 };
  };
  const r = await searchWebVideos('שיעור בפרשה', { env: { SERPER_API_KEY: 'k' }, fetchImpl });
  assert.equal(r.items[0].site, 'hidabroot.org');
  assert.equal(r.items[1].title, 'שיעור');
  assert.ok(!r.items.some(x => x.url.endsWith('.pdf')));
  assert.equal(r.items.filter(x => x.site === 'hidabroot.org').length, 1);
  assert.ok(r.items.some(x => x.site === 'torah.example'));
});

test('no keys -> empty list, never throws', async () => {
  const r = await searchWebVideos('x', { env: {}, fetchImpl: async () => { throw new Error('no'); } });
  assert.deepEqual(r.items, []);
});
