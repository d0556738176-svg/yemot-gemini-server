import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ytdlpSearchVideos } from '../youtube-ivr.js';

test('YouTube search through yt-dlp has the API shape (no key, no daily quota)', async () => {
  let args = null;
  const out = await ytdlpSearchVideos('ישי ריבו', { execImpl: async (bin, a) => { args = a; return JSON.stringify({ entries: [
    { id: 'kR4bH5teaDI', title: 'מחרוזת שירים - ישי ריבו', channel: 'ר. פ.', upload_date: '20240811', duration: 1622 },
    { id: 'live0000000', title: 'live', live_status: 'is_live' }, { id: 'bad' }] }); } });
  assert.ok(args.at(-1).startsWith('ytsearch40:'));
  assert.equal(out.length, 1);
  assert.deepEqual(out[0], { videoId: 'kR4bH5teaDI', title: 'מחרוזת שירים - ישי ריבו', channelTitle: 'ר. פ.', publishedAt: '2024-08-11T00:00:00Z', description: '' });
});
