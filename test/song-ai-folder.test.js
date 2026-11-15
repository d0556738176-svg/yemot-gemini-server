import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import ffmpegPath from '../ffmpeg-path.js';
import { saveSongToAiFolder, saveSongDownloadCopy, masterExt, AI_SONGS_BASE } from '../song-generator.js';

const spec = { title: 'אור התורה', lyrics: '[Verse 1]\nשורה אחת\nשורה שתיים\n[Chorus]\nפזמון', genre: 'hasidic', mood: 'joyful', tempo: 'mid-tempo', musicPrompt: 'hasidic pop, male vocals, clarinet', language: 'he', durationSeconds: 60 };

async function flacMaster(dir) {
  const f = path.join(dir, 'm.flac');
  execFileSync(ffmpegPath, ['-v', 'error', '-f', 'lavfi', '-i', 'sine=d=2:sample_rate=48000', '-ac', '2', '-c:a', 'flac', f]);
  return fs.readFile(f);
}
const probe = file => { try { execFileSync(ffmpegPath, ['-hide_banner', '-i', file]); } catch (e) { return String(e.stderr); } };

test('the engine master format is read from the bytes', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'mx-'));
  assert.equal(masterExt(await flacMaster(dir)), 'flac');
  assert.equal(masterExt(Buffer.from('ID3....')), 'mp3');
  await fs.rm(dir, { recursive: true, force: true });
});

test('"שירי AI" gets the lossless master untouched with every detail, the full lyrics included', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'aif-'));
  const audio = await flacMaster(dir);
  const sent = [];
  const r = await saveSongToAiFolder(audio, spec, 'abcdef123456', dir, {
    request: 'שיר שמח על לימוד תורה', engine: 'acestep-v15-turbo', now: new Date('2026-11-15T10:00:00Z'),
    countFiles: async () => 3,
    upload: async (file, remote, type) => sent.push({ remote, type, file, bytes: (await fs.stat(file)).size }),
    getFile: async remote => ({ file: { exists: true, size: sent.find(x => x.remote === remote).bytes } })
  });
  assert.equal(r.remote, AI_SONGS_BASE + '/אור התורה - abcdef.flac');
  assert.equal(r.format, 'flac');
  assert.equal(sent[0].type, 'audio/flac');
  const info = probe(sent[0].file);
  assert.match(info, /Audio: flac, 48000 Hz, stereo/);
  for (const re of [/TITLE\s*:\s*אור התורה/i, /LYRICS\s*:\s*\[Verse 1\]/i, /שורה שתיים/, /פזמון/, /ALBUM\s*:\s*שירי AI/i,
    /REQUEST\s*:\s*שיר שמח על לימוד תורה/i, /STYLE\s*:\s*hasidic pop, male vocals/i, /DATE\s*:\s*2026-11-15/i, /SONG_ID\s*:\s*abcdef123456/i, /ENGINE\s*:\s*acestep-v15-turbo/i]) assert.match(info, re);
  await fs.rm(dir, { recursive: true, force: true });
});

test('a full folder continues in "שירי AI_2"', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'aif2-'));
  const audio = await flacMaster(dir);
  const sent = [];
  const r = await saveSongToAiFolder(audio, spec, 'ffffff000000', dir, {
    countFiles: async p => (p === AI_SONGS_BASE ? 2900 : 10),
    upload: async (file, remote) => sent.push({ remote, bytes: (await fs.stat(file)).size }),
    getFile: async remote => ({ file: { exists: true, size: sent.find(x => x.remote === remote).bytes } })
  });
  assert.ok(r.remote.startsWith(AI_SONGS_BASE + '_2/'));
  await fs.rm(dir, { recursive: true, force: true });
});

test('from a lossless master the אודיו copy is the best mp3 (320k) with its details', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'aud-'));
  const audio = await flacMaster(dir);
  const sent = [];
  const folders = { nextFolder: async () => 'ivr2:/אודיו', countSaved: async () => {}, yemotFileCount: async () => 0 };
  const r = await saveSongDownloadCopy(audio, spec, 'abcdef123456', dir, {
    folders,
    upload: async (file, remote) => sent.push({ remote, file, bytes: (await fs.stat(file)).size }),
    getFile: async remote => ({ file: { exists: true, size: sent.find(x => x.remote === remote).bytes } })
  });
  assert.match(r.remote, /\.mp3$/);
  assert.match(probe(sent[0].file), /mp3.*320 kb\/s/s);
  await fs.rm(dir, { recursive: true, force: true });
});
