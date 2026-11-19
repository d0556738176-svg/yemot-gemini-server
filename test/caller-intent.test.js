import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isCapabilityQuestion } from '../caller-intent.js';
import { webSearchIntent } from '../web-media-intent.js';
import { ext3Turn } from '../ext3-brain.js';

const quiet = { info() {}, warn() {} };
test('questions about the system vs requests (owner, 19.11)', () => {
  for (const q of ['אתה מוריד רק מיוטיוב?', 'האם אתה יכול להוריד מאתרים אחרים', 'מאיזה אתרים אתה מוריד', 'באיזו איכות אתה מוריד', 'האם את יכולה להוריד שירים מכל האתרים באינטרנט?'])
    assert.equal(isCapabilityQuestion(q), true, q);
  for (const q of ['תוכל להוריד לי את השיר אדון עולם', 'תורידי לי את השיר אדון עולם מיוטיוב', 'תמצאי לי ביוטיוב שיר של ישי ריבו', 'האם ישי ריבו הוציא שיר חדש', 'האם אתה זוכר מה דיברנו'])
    assert.equal(isCapabilityQuestion(q), false, q);
});
test('"can you download songs from all the sites?" is not sent to the whole-web search', () => {
  assert.equal(webSearchIntent('האם את יכולה להוריד שירים מכל האתרים באינטרנט?'), null);
  assert.ok(webSearchIntent('תחפשי לי בכל האתרים באינטרנט הקלטה של שיעור של הרב זילברשטיין'));
});
test('"do you download only from YouTube?" gets an answer about the system, never a search', async () => {
  let prompt = '', searched = false;
  const llm = async (p, o = {}) => { if (o.planner) return JSON.stringify({ intent: 'video_find', standalone: 'האם מורידים רק מיוטיוב', yt_he: 'יוטיוב' }); prompt = p; return JSON.stringify({ answer: 'לא רק מיוטיוב. אפשר גם מאתרים רבים אחרים.' }); };
  const r = await ext3Turn({ utterance: 'אתה מוריד רק מיוטיוב?', now: 'x' }, { llm, log: quiet, webSearch: async () => { searched = true; return []; }, youtubeProxy: async () => { searched = true; return { items: [] }; } });
  assert.equal(r.intent, 'chat');
  assert.equal(searched, false);
  assert.match(prompt, /לא רק מיוטיוב/);
  assert.match(r.reply, /לא רק מיוטיוב/);
});
