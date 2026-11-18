import test from 'node:test';
import assert from 'node:assert/strict';
import { rankMedia } from './browser-media.js';
import { viaBrowser } from './web-media.js';

test('browser engine ranks whole playlists first and drops pieces and adverts', () => {
  const r = rankMedia([
    { url: 'https://cdn.x/seg-12.ts' }, { url: 'https://pubads.g.doubleclick.net/ad.mp4', length: 9e6 },
    { url: 'https://cdn.x/v/clip.mp4', length: 50e6 }, { url: 'https://cdn.x/hls/master.m3u8?t=1' }, { url: 'https://cdn.x/beep.mp3', length: 2000 },
  ]);
  assert.deepEqual(r.map(x => x.url), ['https://cdn.x/hls/master.m3u8?t=1', 'https://cdn.x/v/clip.mp4']);
});

test('a page only a browser can play becomes a downloadable item (cookie never stored)', async () => {
  const it = await viaBrowser({ url: 'https://site.example/ep/7', title: 'פרק 7' }, {
    browserOn: true, streamlinkOn: false, isLive: async () => false,
    sniff: async () => ({ title: 'פרק 7 המלא', media: [{ url: 'https://cdn.example/m.m3u8', headers: { 'User-Agent': 'UA', Referer: 'https://site.example/ep/7' }, cookie: 's=1' }] }),
    probeStreams: async (u, o) => { assert.equal(o.cookie, 's=1'); return { streams: [{ codec_type: 'video' }, { codec_type: 'audio' }], format: { duration: '1800' } }; },
  });
  assert.equal(it.url, 'https://cdn.example/m.m3u8'); assert.equal(it.page, 'https://site.example/ep/7');
  assert.equal(it.durationSec, 1800); assert.ok(it.hasVideo && it.hasAudio && it.browser);
  assert.ok(!JSON.stringify(it).includes('s=1'));
});
