import test from 'node:test';
import assert from 'node:assert/strict';
import { mediaInHtml, inspectLink, searchWebMedia } from './web-media.js';
import { noResultsText } from './branch2-web-flow.js';

test('nested episode VideoObject prefers exact contentUrl over player', () => {
  const html = `<meta property="og:video" content="https://example.com/player"><script type="application/ld+json">${JSON.stringify({ '@type': 'TVEpisode', video: { '@type': 'VideoObject', contentUrl: 'https://cdn.example.com/master.m3u8?token=a&b=c' } })}</script>`;
  assert.equal(mediaInHtml(html, 'https://example.com/episode').media, 'https://cdn.example.com/master.m3u8?token=a&b=c');
});

test('graph and malformed JSON leave ordinary media extraction intact', () => {
  assert.equal(mediaInHtml('<script type="application/ld+json">bad</script><audio src="/clip.mp3">', 'https://example.com/').media, 'https://example.com/clip.mp3');
  const html = `<script type="application/ld+json">{"@graph":[{"@type":["VideoObject"],"contentUrl":"/master.m3u8"}]}</script>`;
  assert.equal(mediaInHtml(html, 'https://example.com/').media, 'https://example.com/master.m3u8');
});

test('scanned manifest is probed with episode referer and registered only on success', async () => {
  const calls = [];
  const item = await inspectLink({ url: 'https://example.com/episode', title: 'Episode' }, {
    probe: async (url, opts) => { calls.push([url, opts.referer]); return calls.length === 1 ? { ok: false, err: 'unsupported' } : { ok: true, info: { url, ext: 'mp4', duration: 3000, formats: [{ vcodec: 'h264', acodec: 'aac' }] } }; },
    scan: async () => ({ media: 'https://cdn.example.com/master.m3u8', title: 'Episode' })
  });
  assert.equal(calls[1][1], 'https://example.com/episode');
  assert.equal(item.url, 'https://cdn.example.com/master.m3u8');
  assert.ok(item.hasVideo && item.hasAudio);
});

test('403 is reported as blocked, never as a playable result', async () => {
  const result = await searchWebMedia('episode', { candidates: [{ url: 'https://example.com/episode', title: 'Episode' }],
    inspect: (c, opts) => inspectLink(c, { ...opts, probe: async () => ({ ok: false, err: 'HTTP Error 403: Forbidden' }), scan: async () => ({ media: 'https://cdn.example.com/master.m3u8' }) }) });
  assert.equal(result.items.length, 0);
  assert.equal(result.unavailable[0].reason, 'access_denied');
  assert.match(noResultsText(result, 'episode'), /חסם/);
  assert.doesNotMatch(noResultsText(result, 'episode'), /לא מצאתי/);
});

test('empty search retains empty result wording and YouTube candidates are preserved', async () => {
  assert.match(noResultsText({}, 'episode'), /לא מצאתי/);
  const result = await searchWebMedia('episode', { candidates: [{ url: 'https://www.youtube.com/watch?v=abcdefghijk', title: 'Clip' }], inspect: async () => { throw Error('must not probe YouTube'); } });
  assert.equal(result.youtube.length, 1);
});
