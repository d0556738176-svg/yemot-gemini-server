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

test('DASH manifests and multiple media alternatives are retained', () => {
  const r = mediaInHtml('<video src="https://cdn.example.com/ad.mp4"></video><script>const source="https://cdn.example.com/main.mpd?token=abc";</script>', 'https://example.com/episode');
  assert.deepEqual(r.mediaUrls, ['https://cdn.example.com/ad.mp4', 'https://cdn.example.com/main.mpd?token=abc']);
});

test('failed first media does not discard a valid second source', async () => {
  const calls = [];
  const item = await inspectLink({ url: 'https://example.com/multi', title: 'Multi' }, {
    probe: async (url, opts) => { calls.push([url, opts.timeoutMs]); return url.endsWith('main.mpd') ? { ok: true, info: { url, ext: 'mp4', duration: 120, formats: [{ vcodec: 'h264', acodec: 'aac' }], http_headers: { Origin: 'https://example.com', Authorization: 'secret' } } } : { ok: false, err: 'not supported' }; },
    scan: async () => ({ media: 'https://cdn.example.com/ad', mediaUrls: ['https://cdn.example.com/ad', 'https://cdn.example.com/main.mpd'] })
  });
  assert.equal(item.url, 'https://cdn.example.com/main.mpd');
  assert.deepEqual(item.httpHeaders, { Origin: 'https://example.com' });
  assert.equal(calls.length, 3);
  assert.ok(calls.every(x => x[1] <= 30000));
});

test('extractor retries and scan share a single deadline', async () => {
  let calls = 0, scans = 0;
  const item = await inspectLink({ url: 'https://example.com/slow' }, { timeoutMs: 5,
    probe: async () => { calls++; await new Promise(r => setTimeout(r, 15)); return { ok: false, err: '403' }; },
    scan: async () => { scans++; return null; }
  });
  assert.equal(item, null);
  assert.equal(calls, 1);
  assert.equal(scans, 0);
});

test('playlists without codec metadata are verified using stream inspection', async () => {
  const item = await inspectLink({ url: 'https://example.com/stream' }, {
    probe: async () => ({ ok: true, info: { url: 'https://cdn.example.com/stream.m3u8', ext: 'mp4', formats: [{ url: 'https://cdn.example.com/stream.m3u8' }] } }),
    probeStreams: async () => ({ streams: [{ codec_type: 'audio' }, { codec_type: 'video' }], format: { duration: '30' } })
  });
  assert.ok(item.hasAudio && item.hasVideo);
  assert.equal(item.durationSec, 30);
});

test('unknown codecs are never assumed playable when stream verification fails', async () => {
  const item = await inspectLink({ url: 'https://example.com/unknown' }, {
    probe: async () => ({ ok: true, info: { url: 'https://cdn.example.com/stream.m3u8', ext: 'mp4' } }),
    probeStreams: async () => null
  });
  assert.equal(item, null);
});

test('Mako resolved source uses the authorized UA and referer through registration', async () => {
  const url = 'https://www.mako.co.il/mako-vod-keshet/show/VOD-abc.htm';
  const calls = [];
  const item = await inspectLink({ url, title: 'Episode' }, {
    resolveMako: async () => ({ media: 'https://cdn.akamaized.net/master.m3u8?token=temporary', mediaUrls: ['https://cdn.akamaized.net/master.m3u8?token=temporary'], httpHeaders: { 'User-Agent': 'Ticket-UA', Referer: 'https://www.mako.co.il/' } }),
    probe: async (u, opts) => { calls.push([u, opts]); return { ok: true, info: { url: u, ext: 'mp4', duration: 3000, formats: [{ vcodec: 'h264', acodec: 'aac' }] } }; }
  });
  assert.equal(calls.length, 1);
  assert.equal(calls[0][1].httpHeaders['User-Agent'], 'Ticket-UA');
  assert.equal(item.httpHeaders['User-Agent'], 'Ticket-UA');
  assert.equal(item.referer, 'https://www.mako.co.il/');
  assert.equal(item.page, url);
});
