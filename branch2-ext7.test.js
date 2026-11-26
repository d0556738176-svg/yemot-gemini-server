import test from 'node:test';
import assert from 'node:assert/strict';
import { publishToExt7, EXT7_SETTINGS, EXT8_SETTINGS } from './branch2-ext7.js';

function fakeIo({ failUploadOnce = false } = {}) {
  const json = new Map(), uploads = [];
  let fail = failUploadOnce;
  return { json, uploads, io: {
    readJson: async p => json.get(p) ?? null,
    writeJson: async (p, v) => { json.set(p, structuredClone(v)); },
    upload: async (_, remote) => { if (fail) { fail = false; throw Error('upload failed'); } uploads.push(remote); },
  } };
}

test('songs get rising numbers so Yemot plays the newest first', async () => {
  const f = fakeIo();
  await publishToExt7('aaaaaaaaaaa', '/tmp/a.wav', 'A', f.io);
  await publishToExt7('bbbbbbbbbbb', '/tmp/b.wav', 'B', f.io);
  assert.deepEqual(f.uploads, ['ivr2:/7/000.wav', 'ivr2:/7/001.wav']);
});

test('the same video is never added twice, even when requests overlap', async () => {
  const f = fakeIo();
  await Promise.all([publishToExt7('aaaaaaaaaaa', '/tmp/a.wav', 'A', f.io), publishToExt7('aaaaaaaaaaa', '/tmp/a.wav', 'A', f.io),
    publishToExt7('bbbbbbbbbbb', '/tmp/b.wav', 'B', f.io)]);
  assert.deepEqual(f.uploads, ['ivr2:/7/000.wav', 'ivr2:/7/001.wav']);
});

test('an upload that keeps failing leaves a gap, never two songs on one number', async () => {
  const f = fakeIo({ failUploadOnce: true });
  f.io.retryWaits = [0]; // no second try here: the failure must leave only a gap
  await assert.rejects(publishToExt7('aaaaaaaaaaa', '/tmp/a.wav', 'A', f.io));
  await publishToExt7('bbbbbbbbbbb', '/tmp/b.wav', 'B', f.io);
  assert.deepEqual(f.uploads, ['ivr2:/7/001.wav']);
});

test('keys match the requested layout', () => {
  assert.equal(EXT7_SETTINGS.type, 'playfile');
  assert.equal(EXT7_SETTINGS.control_play4, 'minus');
  assert.equal(EXT7_SETTINGS.control_play6, 'plus');
  assert.equal(EXT7_SETTINGS.control_play5, 'wait');
  assert.equal(EXT7_SETTINGS.control_play1, 'seconds_plus');
  assert.equal(EXT7_SETTINGS.control_play3, 'seconds_minus');
  assert.equal(EXT7_SETTINGS.control_play7, 'minut_plus_amount1');
  assert.equal(EXT7_SETTINGS.minut_plus_amount1, '180000');
  // 12.11: * is Yemot's own star menu again; 0 returns to the main menu.
  assert.equal(EXT7_SETTINGS['control_play*'], undefined);
  assert.equal(EXT7_SETTINGS.control_play0, 'go_to_folder');
  assert.equal(EXT7_SETTINGS.playfile_control_play_0_goto, '/');
  assert.equal(EXT8_SETTINGS.control_play0, 'go_to_folder');
  assert.equal(EXT7_SETTINGS.control_play2, 'send_api'); // 27.11: delete from the whole system
});

import { backfillExt7 } from './branch2-ext7.js';
test('backfill adds saved songs oldest-first (so the newest plays first), joining pieces, once', async () => {
  const f = fakeIo(); const joined = [];
  const hex = id => Buffer.from(id).toString('hex');
  f.json.set('ivr2:/2/youtubeaudio/' + hex('newerSong11') + '/complete.json', { complete: true, videoId: 'newerSong11', createdAt: '2026-11-02T10:00:00Z', playbackPaths: ['/2/youtubeaudio/x/שיר_חדש'] });
  f.json.set('ivr2:/2/youtubeaudio/' + hex('olderSong11') + '/complete.json', { complete: true, videoId: 'olderSong11', createdAt: '2026-10-30T10:00:00Z', playbackPaths: ['/2/youtubeaudio/y/001', '/2/youtubeaudio/y/002'] });
  const io = { ...f.io, listSongDirs: async () => [hex('newerSong11'), hex('olderSong11'), 'notasong'],
    downloadTo: async () => {}, joinWavs: async parts => { joined.push(parts.length); }, tempDir: async () => '/tmp/x', removeDir: async () => {} };
  await backfillExt7(io);
  assert.deepEqual(f.uploads, ['ivr2:/7/000.wav', 'ivr2:/7/001.wav']);
  assert.equal(f.json.get('ivr2:/2/youtubeaudio/ext7_index.json').items.newerSong11.file, '001');
  assert.deepEqual(joined, [2]);
  await backfillExt7(io);
  assert.equal(f.uploads.length, 2, 'runs once');
});
test('an empty listing is not marked done', async () => {
  const f = fakeIo();
  await backfillExt7({ ...f.io, listSongDirs: async () => [] });
  assert.equal(f.json.get('ivr2:/2/youtubeaudio/ext7_backfill_v1.json'), undefined);
});

test('extension 8 returns to the last place; extension 7 saves that place', () => {
  assert.equal(EXT8_SETTINGS.type, 'last_play');
  assert.equal(EXT7_SETTINGS.save_last_play, 'yes');
});

import { stripUnusedKeys } from './branch2-ext7.js';
test('a key the layout no longer uses is removed from ext.ini', () => {
  const out = stripUnusedKeys('type=playfile\ncontrol_play2=seconds_minus\ncontrol_play1=seconds_plus\ntitle=x', EXT8_SETTINGS);
  assert.equal(out, 'type=playfile\ncontrol_play1=seconds_plus\ntitle=x');
});

test('old star lines are removed from extensions 7 and 8', () => {
  const out = stripUnusedKeys('type=playfile\ncontrol_play*=go_to_folder\nplayfile_control_play_*_goto=/\ncontrol_play0=go_to_folder\nplayfile_control_play_0_goto=/', EXT7_SETTINGS);
  assert.equal(out, 'type=playfile\ncontrol_play0=go_to_folder\nplayfile_control_play_0_goto=/');
});

import { withMainMenuKey } from './branch2-star-keys.js';
test('every playback extension: star lines out, 0 = main menu, other lines kept', () => {
  assert.equal(withMainMenuKey('type=playfile\r\ncontrol_play*=go_to_folder\r\nplayfile_control_play_*_goto=/\r\ntitle=x\r\n'),
    'type=playfile\ntitle=x\ncontrol_play0=go_to_folder\nplayfile_control_play_0_goto=/\n');
  const once = withMainMenuKey('type=last_play');
  assert.equal(withMainMenuKey(once), once);
});

test('a failed upload to extension 7 is tried again before the song is given up (19.11)', async () => {
  const { publishToExt7 } = await import('./branch2-ext7.js');
  let store = {}, tries = 0;
  const io = { retryWaits: [0, 1, 1], readJson: async p => store[p] || null, writeJson: async (p, d) => { store[p] = d; },
    upload: async () => { if (++tries < 3) throw new Error('Yemot busy'); }, log: { info() {}, warn() {} } };
  const e = await publishToExt7('abcdefghijk', '/tmp/x.wav', 'שיר', io);
  assert.equal(tries, 3); assert.equal(e.file, '000');
});
