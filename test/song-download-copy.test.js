import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import ffmpegPath from 'ffmpeg-static';
import { saveSongDownloadCopy } from '../song-generator.js';

test('an AI song is saved to the audio folder with its details, unchanged in quality', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'songcopy-'));
  execFileSync(ffmpegPath, ['-v', 'error', '-f', 'lavfi', '-i', 'sine=d=2', '-c:a', 'libmp3lame', '-b:a', '320k', path.join(dir, 'in.mp3')]);
  const audio = await fs.readFile(path.join(dir, 'in.mp3'));
  const sent = [];
  const folders = { nextFolder: async () => 'ivr2:/אודיו', countSaved: async () => {}, yemotFileCount: async () => 0 };
  const r = await saveSongDownloadCopy(audio, { title: 'אור התורה', lyrics: 'שורה אחת\nשורה שתיים', genre: 'חסידי' }, 'abcdef123456', dir, {
    folders,
    upload: async (file, remote) => sent.push({ remote, bytes: (await fs.stat(file)).size, file }),
    getFile: async remote => ({ file: { exists: true, size: sent.find(x => x.remote === remote).bytes } })
  });
  assert.equal(r.remote, 'ivr2:/אודיו/שיר AI - אור התורה - abcdef.mp3');
  const probe = (() => { try { execFileSync(ffmpegPath, ['-hide_banner', '-i', sent[0].file]); } catch (e) { return String(e.stderr); } })();
  assert.match(probe, /title\s*:\s*אור התורה/);
  assert.match(probe, /artist\s*:\s*שיר בינה מלאכותית/);
  assert.match(probe, /320 kb\/s/);
  await fs.rm(dir, { recursive: true, force: true });
});
