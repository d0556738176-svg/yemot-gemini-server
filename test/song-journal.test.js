import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const dir = mkdtempSync(path.join(tmpdir(), 'song-journal-'));
process.env.SONG_STATE_DIR = dir;
process.env.SONG_JOURNAL_FILE = path.join(dir, 'song-journal.json');
process.env.SONG_EVENTS_FILE = path.join(dir, 'song-events.json');
process.env.SONG_LLM_TIMEOUT_MS = '30000';
writeFileSync(process.env.SONG_JOURNAL_FILE, JSON.stringify({
  'cut-off-0001': { prompt: 'שיר על שבת', userKey: 'x', stage: 'lyrics', at: Date.now() },
  'too-old-0001': { prompt: 'שיר', stage: 'queued', at: Date.now() - 5 * 3600000 },
  'tried-0001': { prompt: 'שיר', stage: 'queued', at: Date.now(), resumes: 2 }
}));
const { resumeSongJobs, createSong } = await import('../song-generator.js');

test('a song cut off by a restart is made again; old or retried ones are dropped', async () => {
  const asked = [];
  const n = resumeSongJobs({ generateText: async p => { asked.push(p); throw Object.assign(new Error('no writer in test'), { status: 503 }); } });
  assert.equal(n, 1);
  await new Promise(r => setTimeout(r, 300));
  assert.ok(asked.length >= 1, 'the lyrics writer was asked again');
  const left = JSON.parse(readFileSync(process.env.SONG_JOURNAL_FILE, 'utf8'));
  assert.deepEqual(Object.keys(left), [], 'ended songs leave the journal');
});

test('a new request is written down until it ends', async () => {
  let seen = null;
  await createSong({ prompt: 'שיר על חנוכה', generateText: async () => { seen = JSON.parse(readFileSync(process.env.SONG_JOURNAL_FILE, 'utf8')); throw new Error('stop'); } }).catch(() => {});
  assert.equal(Object.values(seen)[0].stage, 'lyrics');
  assert.deepEqual(JSON.parse(readFileSync(process.env.SONG_JOURNAL_FILE, 'utf8')), {});
});
