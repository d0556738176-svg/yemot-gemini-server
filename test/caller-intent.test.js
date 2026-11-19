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

import { pickMany } from '../ext3-brain.js';
const OPTS = [1, 2, 3].map(i => ({ videoId: 'abcdefghij' + i, title: 'שיר ' + i, durationSec: 200 }));
test('several videos at once: which ones he meant', () => {
  assert.deepEqual(pickMany('תוריד את כולם', OPTS).map(v => v.videoId), ['abcdefghij1', 'abcdefghij2', 'abcdefghij3']);
  assert.deepEqual(pickMany('תורידי את אחת ושלוש', OPTS).map(v => v.videoId), ['abcdefghij1', 'abcdefghij3']);
  assert.deepEqual(pickMany('תוריד לי את השני והשלישי', OPTS).map(v => v.videoId), ['abcdefghij2', 'abcdefghij3']);
  assert.deepEqual(pickMany('תוריד את השני', OPTS), []);
});
test('"download them all" after a list: one confirmation naming every file, nothing downloaded yet', async () => {
  const llm = async (p, o = {}) => o.planner ? JSON.stringify({ intent: 'video_play', standalone: 'להוריד את כולם' }) : JSON.stringify({ answer: 'x' });
  const options = OPTS.map(v => ({ ...v, type: 'video' }));
  const r = await ext3Turn({ utterance: 'תורידי את כולם', now: 'x', current: [{ user: 'שירים של ישי ריבו', assistant: 'מצאתי', ref: { type: 'video', videoId: 'abcdefghij1', title: 'שיר 1', options } }] }, { llm, log: quiet });
  assert.equal(r.confirm?.batch?.length, 3);
  assert.match(r.reply, /3 יחד: 1, שיר 1.*2, שיר 2.*3, שיר 3/);
  assert.match(r.reply, /כולם כקובצי שמע הקש 1/);
});
test('a named site is a whole-web request (the site stays in the search)', () => {
  assert.equal(webSearchIntent('תוריד לי שיעור של הרב זילברשטיין מאתר קול הלשון'), 'שיעור של הרב זילברשטיין מאתר קול הלשון');
  assert.equal(webSearchIntent('האם את יכולה להוריד מאתר קול הלשון?'), null);
});

test('a new song from the conversation: details read back, created only after the key', async () => {
  const llm = async (p, o = {}) => {
    if (o.planner) return JSON.stringify({ intent: 'song_make' });
    return JSON.stringify({ title: 'שבת מלכתא', topic: 'שיר שמח לכבוד שבת', style: 'חסידי עם גיטרה', voice: 'ילד', lyrics: 'שבת באה אלינו\nהנרות דולקים', brief: 'שיר שמח לכבוד שבת, חסידי עם גיטרה, בקול ילד' });
  };
  const r = await ext3Turn({ utterance: 'עכשיו תיצרי את השיר', now: 'x', current: [{ user: 'בואי נכתוב שיר לשבת', assistant: 'שבת באה אלינו, הנרות דולקים' }] }, { llm, log: quiet });
  assert.equal(r.intent, 'song_make');
  assert.ok(r.confirm?.song?.brief.includes('מילות השיר'));
  assert.match(r.reply, /שם השיר: שבת מלכתא.*סגנון: חסידי עם גיטרה.*קול: ילד.*שבת באה אלינו/);
  assert.match(r.reply, /ליצירת השיר הקש 1, לשינוי פרטים הקש 2, לביטול הקש 3/);
});
test('"can you make songs?" is a question, not a song order', async () => {
  const llm = async (p, o = {}) => o.planner ? JSON.stringify({ intent: 'song_make' }) : JSON.stringify({ answer: 'כן, אפשר ליצור שיר.' });
  const r = await ext3Turn({ utterance: 'האם את יכולה ליצור שירים?', now: 'x' }, { llm, log: quiet });
  assert.equal(r.intent, 'chat'); assert.equal(r.confirm, undefined);
});

import { findVideos } from '../ext3-brain.js';
test('YouTube quota used up: the search goes on through the server (yt-dlp), free and unlimited', async () => {
  const refused = async () => ({ ok: false, status: 403, json: async () => ({ error: { message: 'quotaExceeded' } }) });
  const searchImpl = async qs => [{ videoId: 'kR4bH5teaDI', title: 'מחרוזת שירים - ישי ריבו', channelTitle: 'ר. פ.', description: '', publishedAt: '2024-08-11T00:00:00Z', language: '', durationSec: 1622, viewCount: 1000000, ageRestricted: false, live: false }];
  const v = await findVideos(['ישי ריבו'], { env: { YOUTUBE_API_KEY: 'k' }, fetchImpl: refused, searchImpl });
  assert.equal(v[0]?.videoId, 'kR4bH5teaDI');
});
