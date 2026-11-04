import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { buildId3Tag, embedCoverInWav, fetchThumbnail } from './youtube-cover-art.js';

function wav(samples) {
  const data = Buffer.alloc(samples * 2), h = Buffer.alloc(44);
  h.write('RIFF', 0, 'latin1'); h.writeUInt32LE(36 + data.length, 4); h.write('WAVE', 8, 'latin1');
  h.write('fmt ', 12, 'latin1'); h.writeUInt32LE(16, 16); h.writeUInt16LE(1, 20); h.writeUInt16LE(1, 22);
  h.writeUInt32LE(8000, 24); h.writeUInt32LE(16000, 28); h.writeUInt16LE(2, 32); h.writeUInt16LE(16, 34);
  h.write('data', 36, 'latin1'); h.writeUInt32LE(data.length, 40);
  return Buffer.concat([h, data]);
}

test('the picture goes after the audio; header and audio stay byte-identical', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'cov-'));
  const f = path.join(dir, 'a.wav'), orig = wav(8000);
  await fs.writeFile(f, orig);
  const jpeg = Buffer.concat([Buffer.from([0xff, 0xd8]), Buffer.alloc(3001, 7)]);
  assert.equal(await embedCoverInWav(f, buildId3Tag({ title: 'שיר', jpeg })), true);
  const out = await fs.readFile(f);
  assert.deepEqual(out.subarray(8, orig.length), orig.subarray(8)); // header (minus RIFF size) + audio unchanged
  assert.equal(out.readUInt32LE(4), out.length - 8);
  assert.equal(out.length % 2, 0);
  assert.equal(out.toString('latin1', orig.length, orig.length + 4), 'id3 ');
  assert.ok(out.includes(Buffer.from('APIC', 'latin1')));
  // Never twice, never on a non-canonical file.
  assert.equal(await embedCoverInWav(f, buildId3Tag({ title: 'x' })), false);
  await fs.rm(dir, { recursive: true, force: true });
});

test('thumbnail: skips missing sizes and non-JPEG placeholders', async () => {
  const calls = [];
  const jpeg = Buffer.concat([Buffer.from([0xff, 0xd8]), Buffer.alloc(5000)]);
  const t = await fetchThumbnail('86eLl-ZYt4A', { fetchImpl: async url => {
    calls.push(String(url));
    if (/maxres/.test(url)) return new Response('', { status: 404 });
    if (/sddefault/.test(url)) return new Response(Buffer.alloc(100));
    return new Response(jpeg);
  } });
  assert.equal(t.name, 'hqdefault');
  assert.equal(calls.length, 3);
  assert.equal(await fetchThumbnail('bad id'), null);
});
