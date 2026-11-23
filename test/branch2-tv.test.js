import test from 'node:test';
import assert from 'node:assert/strict';
import { TV_CHANNELS, parseOverrides, candidatesFor, pickOfficialLive, findChannelSource, menuText, forget } from '../branch2-tv.js';

test('eight channels on keys 1-8 in the owner\'s order', () => {
  assert.deepEqual(TV_CHANNELS.map(c => c.key), ['1', '2', '3', '4', '5', '6', '7', '8']);
  assert.equal(TV_CHANNELS[7].title, 'רדיו ערוץ 14');
  assert.equal(TV_CHANNELS[5].title, 'ערוץ הכנסת');
  assert.match(menuText(), /^ברוכים הבאים לשידורים החיים\. לכאן 11 הקישו 1, /);
  assert.match(menuText(), /לחזרה הקישו כוכבית\.$/);
});

test('owner overrides: only keys 1-6 and real web addresses', () => {
  const o = parseOverrides('1=https://a.example/live.m3u8\n9=https://x.example\n2=ftp://bad\n2 = http://b.example/p\njunk');
  assert.deepEqual(o, { 1: ['https://a.example/live.m3u8'], 2: ['http://b.example/p'] });
  assert.deepEqual(candidatesFor(TV_CHANNELS[0], o), ['https://a.example/live.m3u8', ...TV_CHANNELS[0].pages]);
});

test('YouTube: only the broadcaster\'s own channel is taken', () => {
  const ch = TV_CHANNELS.find(c => c.key === '5');
  const pick = pickOfficialLive(ch, [{ url: 'u1', uploader: 'Some fan' }, { url: 'u2', uploader: 'i24NEWS עברית' }]);
  assert.equal(pick.url, 'u2');
  assert.equal(pickOfficialLive(ch, [{ url: 'u1', uploader: 'Some fan' }]), null);
});

test('source: site first, then official YouTube live, and cached', async () => {
  const ch = TV_CHANNELS[0]; forget(ch.key);
  let calls = 0;
  const deps = {
    resolveStream: async url => { calls++; return url.includes('youtube') ? 'https://media/x.m3u8' : null; },
    youtubeLiveNow: async () => [{ url: 'https://www.youtube.com/watch?v=abcdefghijk', uploader: 'כאן | חדשות' }],
  };
  const r = await findChannelSource(ch, deps);
  assert.equal(r.how, 'youtube');
  assert.equal(r.page, 'https://www.youtube.com/watch?v=abcdefghijk');
  const before = calls;
  await findChannelSource(ch, deps);
  assert.equal(calls, before, 'second lookup comes from the cache');
});

test('source: nothing playable -> no page (caller hears "not available")', async () => {
  const ch = TV_CHANNELS[3]; forget(ch.key);
  const r = await findChannelSource(ch, { resolveStream: async () => null, youtubeLiveNow: async () => [] });
  assert.equal(r.page, null);
});

test('channel 13 never takes another station with 13 in its name', () => {
  const ch = TV_CHANNELS.find(c => c.key === '3');
  assert.equal(pickOfficialLive(ch, [{ url: 'u1', uploader: 'ABC13 Houston' }]), null);
  assert.equal(pickOfficialLive(ch, [{ url: 'u2', uploader: 'חדשות 13' }]).url, 'u2');
  const c14 = TV_CHANNELS.find(c => c.key === '4');
  assert.equal(pickOfficialLive(c14, [{ url: 'x', uploader: 'WFLA 14' }]), null);
  assert.equal(pickOfficialLive(c14, [{ url: 'y', uploader: 'C14' }]).url, 'y');
});

test('a page without a direct stream: its own player is found inside it', async () => {
  const ch = TV_CHANNELS.find(c => c.key === '7'); forget(ch.key);
  const r = await findChannelSource(ch, {
    resolveStream: async () => null, youtubeLiveNow: async () => [],
    inspect: async () => ({ url: 'https://cdn.example/radio.m3u8', hasAudio: true, live: true, referer: 'https://www.i24news.co.il/live-radio' }),
  });
  assert.equal(r.how, 'page');
  assert.equal(r.page, 'https://cdn.example/radio.m3u8');
  assert.equal(r.referer, 'https://www.i24news.co.il/live-radio');
});

test('radio with no stream and no YouTube: reason is kept for the check page', async () => {
  const ch = TV_CHANNELS.find(c => c.key === '8'); forget(ch.key);
  const r = await findChannelSource(ch, { resolveStream: async () => null, youtubeLiveNow: async () => [], inspect: async (c, o) => { o.onFailure({ reason: 'access_denied' }); return null; } });
  assert.equal(r.page, null);
  assert.match(r.tried[0], /access_denied/);
});

test('relay: consecutive pieces are played together, up to three', async () => {
  const { followingPieces, resolveStreamInfo } = await import('../live-relay.js');
  const r = { pieces: [3, 4, 5, 7, 8].map(no => ({ no, play: '/p/' + no })) };
  assert.deepEqual(followingPieces(r, r.pieces[0]).map(p => p.no), [3, 4, 5]);
  assert.deepEqual(followingPieces(r, r.pieces[2]).map(p => p.no), [5], 'a missing piece is never skipped over');
  const direct = await resolveStreamInfo('https://cdn.example/live.m3u8?t=1', { referer: 'https://site.example/live' });
  assert.equal(direct.url, 'https://cdn.example/live.m3u8?t=1');
  assert.equal(direct.headers.Referer, 'https://site.example/live');
});

test('a relay link that carries the station address gives that address', async () => {
  const { unwrapRelay } = await import('../branch2-tv.js');
  assert.equal(unwrapRelay('https://radiomood.co.il/api/radio-stream?url=' + encodeURIComponent('https://live.example.fm/live.mp3?x=1')), 'https://live.example.fm/live.mp3?x=1');
  assert.equal(unwrapRelay('https://radiomood.co.il/api/radio-stream?station=kol-chai'), null);
  assert.equal(unwrapRelay('https://a.example/x?next=https://a.example/y'), null, 'same site: not a relay');
});

test('radiomood: the station number comes from the site list by name, never the default player', async () => {
  const TV = await import('../branch2-tv.js');
  const raw = String.raw`"stations\\\":[{\\\"id\\\":\\\"station001\\\",\\\"name\\\":\\\"גלגל\\\\\\\"צ\\\",\\\"imagePath\\\":\\\"/a.webp\\\"},{\\\"id\\\":\\\"station002\\\",\\\"name\\\":\\\"גלי צה\\\\\\\"ל (גל\\\\\\\"צ)\\\",\\\"imagePath\\\":\\\"/b.webp\\\"},{\\\"id\\\":\\\"station003\\\",\\\"name\\\":\\\"כאן ב׳\\\",\\\"imagePath\\\":\\\"/c.webp\\\"},{\\\"id\\\":\\\"station020\\\",\\\"name\\\":\\\"רדיו קול חי\\\",\\\"imagePath\\\":\\\"/d.webp\\\"},{\\\"id\\\":\\\"station021\\\",\\\"name\\\":\\\"קול חי מיוזיק\\\",\\\"imagePath\\\":\\\"/e.webp\\\"},{\\\"id\\\":\\\"station030\\\",\\\"name\\\":\\\"103FM\\\",\\\"imagePath\\\":\\\"/f.webp\\\"}]`;
  const list = TV.rmStations(raw);
  assert.equal(list.length, 6);
  const pick = n => TV.rmPick(list, n)?.id;
  assert.equal(pick('גלי צהל'), 'station002');
  assert.equal(pick('כאן ב'), 'station003');
  assert.equal(pick('קול חי'), 'station020');
  assert.equal(pick('קול חי מיוזיק'), 'station021');
  assert.equal(pick('103'), 'station030');
  assert.equal(pick('קול פליי'), undefined);
  // The whole lookup: the relay address of the right station, checked to play.
  const ch = TV.RADIO_CHANNELS.find(c => c.digit === '8');
  TV.forget(ch.key);
  const played = [];
  const r = await TV.findChannelSource(ch, { fetchText: async () => raw, resolveStream: async u => { played.push(u); return { url: u }; }, overrides: {} }, { fresh: true });
  assert.equal(r.page, 'https://radiomood.co.il/api/radio-stream?stationId=station002&sourceIndex=0');
  assert.ok(!played.some(u => /station001/.test(u)), 'never the default station');
});
