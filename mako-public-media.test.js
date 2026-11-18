import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveMakoPublic, isMakoEpisode, MAKO_UA, refreshMakoItem } from './mako-public-media.js';

const episode = 'https://www.mako.co.il/mako-vod-keshet/show/VOD-abc123.htm';
function fixture(caseId = '1') {
  const calls = [];
  return { calls, fetchImpl: async (url, opts) => {
    calls.push({ url, opts });
    return { ok: true, json: async () => url.includes('platform=') ? { root: { vod: { itemVcmId: 'video123', channelId: 'channel123' }, seo: { title: 'Episode' } } } : url.includes('/AjaxPage?') ? { media: [{ cdn: 'AWS', url: 'https://video.cloudfront.net/master.m3u8' }, { cdn: 'AKAMAI', url: 'https://video.akamaized.net/master.m3u8?stale=1' }] } : { caseId, tickets: [{ ticket: 'token%3Dpublic-temporary-ticket' }] } };
  } };
}

test('public entitlement flow resolves both CDNs with consistent playback headers', async () => {
  const f = fixture(); const r = await resolveMakoPublic(episode, f);
  assert.equal(r.mediaUrls.length, 2);
  assert.equal(r.media, 'https://video.cloudfront.net/master.m3u8?token=public-temporary-ticket');
  assert.equal(r.mediaUrls[1], 'https://video.akamaized.net/master.m3u8?token=public-temporary-ticket');
  assert.ok(f.calls.every(x => x.opts.headers['User-Agent'] === MAKO_UA));
  assert.equal(r.httpHeaders['User-Agent'], MAKO_UA);
  assert.ok(f.calls.every(x => x.opts.redirect === 'error'));
});

test('an entitlement refusal never produces a downloadable URL', async () => {
  const r = await resolveMakoPublic(episode, fixture('4'));
  assert.deepEqual(r.mediaUrls, []);
  assert.equal(r.reason, 'access_denied');
});

test('other domains and malformed episode URLs never invoke the resolver', async () => {
  const f = fixture();
  for (const u of ['https://mako.co.il.evil.example/VOD-abc.htm', 'https://evil.example/VOD-abc.htm', 'file:///tmp/VOD-abc.htm', 'https://www.mako.co.il/category']) {
    assert.equal(isMakoEpisode(u), false);
    assert.equal(await resolveMakoPublic(u, f), null);
  }
  assert.equal(f.calls.length, 0);
});

test('untrusted media hosts and missing ticket values are rejected', async () => {
  let n = 0;
  const r = await resolveMakoPublic(episode, { fetchImpl: async () => ({ ok: true, json: async () => ++n === 1 ? { vod: { itemVcmId: 'v', channelId: 'c' } } : { media: [{ cdn: 'AWS', url: 'https://evil.example/master.m3u8' }] } }) });
  assert.equal(r.mediaUrls.length, 0);
  assert.equal(n, 2);
});

test('access errors are returned without exposing temporary tickets or URLs', async () => {
  const r = await resolveMakoPublic(episode, { fetchImpl: async () => ({ ok: false, status: 403 }) });
  assert.equal(r.reason, 'access_denied');
  assert.equal(r.media, null);
});

test('renewing an expiring item preserves its id and obtains alternate CDN URLs', async () => {
  const item = { id: 'w1234567890', page: episode, url: 'https://video.cloudfront.net/master.m3u8?expired=1', title: 'Episode' };
  const r = await refreshMakoItem(item, fixture());
  assert.equal(r.id, item.id);
  assert.ok(!r.url.includes('expired'));
  assert.equal(r.alternateUrls.length, 1);
  const ordinary = { url: 'https://example.com/clip.mp4' };
  assert.equal(await refreshMakoItem(ordinary), ordinary);
});
