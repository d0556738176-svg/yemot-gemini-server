import test from 'node:test';
import assert from 'node:assert/strict';
import { TV_CHANNELS, parseOverrides, candidatesFor, pickOfficialLive, findChannelSource, menuText, forget } from '../branch2-tv.js';

test('six channels on keys 1-6 in the owner\'s order', () => {
  assert.deepEqual(TV_CHANNELS.map(c => c.key), ['1', '2', '3', '4', '5', '6']);
  assert.equal(TV_CHANNELS[5].title, 'ערוץ הכנסת');
  assert.match(menuText(), /^ברוכים הבאים לשידורים החיים\. לכאן 11 הקישו 1, /);
  assert.match(menuText(), /לחזרה הקישו כוכבית\.$/);
});

test('owner overrides: only keys 1-6 and real web addresses', () => {
  const o = parseOverrides('1=https://a.example/live.m3u8\n7=https://x.example\n2=ftp://bad\n2 = http://b.example/p\njunk');
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
