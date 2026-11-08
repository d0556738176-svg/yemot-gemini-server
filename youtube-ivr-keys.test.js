import test from 'node:test';
import assert from 'node:assert/strict';
import { searchYouTubeVideos, youtubeKeysFrom } from './youtube-ivr.js';

test('YouTube search moves to the next key when one key quota is used up', async () => {
  const saved = { ...process.env };
  process.env.YOUTUBE_API_KEY = 'k1'; process.env.YOUTUBE_API_KEY_2 = 'k2'; delete process.env.YOUTUBE_BACKUP_API_KEY;
  try {
    assert.deepEqual(youtubeKeysFrom(process.env), ['k1', 'k2']);
    const used = [];
    const fetchImpl = async url => {
      const key = new URL(url).searchParams.get('key'); used.push(key);
      if (key === 'k1') return { ok: false, status: 403, json: async () => ({ error: { errors: [{ reason: 'quotaExceeded' }] } }) };
      return { ok: true, status: 200, json: async () => ({ items: [{ id: { videoId: 'abc' }, snippet: { title: 'שיר', channelTitle: 'ערוץ' } }] }) };
    };
    const r = await searchYouTubeVideos('שיר חדש', { fetchImpl, timeoutMs: 1000 });
    assert.equal(r[0].videoId, 'abc');
    assert.deepEqual(used, ['k1', 'k2']);
    const used2 = used.length; await searchYouTubeVideos('שיר אחר', { fetchImpl, timeoutMs: 1000 });
    assert.equal(used[used2], 'k2'); // the used-up key rests
  } finally { process.env = saved; }
});
