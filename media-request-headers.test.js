import test from 'node:test';
import assert from 'node:assert/strict';
import { mediaRequestHeaders, mediaHeaderArgs } from './media-request-headers.js';
import { argsFor } from './youtube-direct.js';

test('retain public playback context and discard credentials and unsafe values', () => {
  assert.deepEqual(mediaRequestHeaders({ 'user-agent': 'Browser', referer: 'https://site.example/episode', origin: 'https://site.example', Cookie: 'secret', Authorization: 'secret', Host: 'internal', X: 'other' }), { 'User-Agent': 'Browser', Referer: 'https://site.example/episode', Origin: 'https://site.example' });
  assert.deepEqual(mediaRequestHeaders({ 'User-Agent': 'bad\r\nHeader:x', Origin: 'file:///tmp/x', Referer: 'https://user:pass@site.example/' }), {});
});

test('download arguments retain the extracted context without changing YouTube defaults', () => {
  const before = argsFor('abcdefghijk', '/tmp/out');
  assert.ok(!before.includes('--add-headers'));
  const after = argsFor('abcdefghijk', '/tmp/out', { target: 'https://cdn.example/master.m3u8', referer: 'https://site.example/episode', httpHeaders: { Origin: 'https://site.example' } });
  assert.ok(after.includes('Origin:https://site.example'));
  assert.equal(after.at(-1), 'https://cdn.example/master.m3u8');
  assert.deepEqual(mediaHeaderArgs({ Cookie: 'secret' }), []);
});
