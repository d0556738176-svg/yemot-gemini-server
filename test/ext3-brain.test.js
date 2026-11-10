import test from 'node:test';
import assert from 'node:assert/strict';
import { parseKeyOptions, buildContext, activeVideo, parsePlan, heuristicPlan, isSafeVideo, parseIsoDuration, spokenDuration, ext3Turn, findVideos } from '../ext3-brain.js';

const clown = { type: 'video', videoId: 'abcdefghijk', title: 'The Killer Clown Case That Fooled Everyone', channelTitle: 'Real Channel', durationSec: 1740, viewCount: 120000 };

test('context stays small even with a long memory', () => {
  const prior = Array.from({ length: 70 }, (_, i) => ({ user: 'שאלה ארוכה מספר ' + i + ' '.repeat(10) + 'א'.repeat(300), gemini: 'ב'.repeat(2000) }));
  const current = Array.from({ length: 8 }, (_, i) => ({ user: 'ג'.repeat(500), assistant: 'ד'.repeat(3000), ref: i === 7 ? clown : undefined }));
  const text = buildContext({ summary: 'ה'.repeat(5000), prior, current, maxChars: 5200 });
  assert.ok(text.length <= 5200, 'length ' + text.length);
  assert.match(text, /The Killer Clown/);
});

test('the latest video discussed is found in this call, then in earlier calls', () => {
  assert.equal(activeVideo([], [{ ref: clown }]).videoId, 'abcdefghijk');
  assert.equal(activeVideo([{ ref: { ...clown, videoId: 'zzzzzzzzzzz' } }], [{ ref: clown }]).videoId, 'zzzzzzzzzzz');
  assert.equal(activeVideo([{}], []), null);
});

test('planner output is parsed defensively', () => {
  assert.equal(parsePlan('blah {"intent":"web","search":"שער הדולר"} x').intent, 'web');
  assert.equal(parsePlan('{"intent":"dance"}'), null);
  assert.equal(parsePlan('no json'), null);
});

test('rules without the planner: the word youtube alone does not mean a raw listing', () => {
  assert.equal(heuristicPlan('כן').continueOffer, true);
  assert.equal(heuristicPlan('איזה סרטון הכי מומלץ ביוטיוב על אסונות תעופה').intent, 'video_find');
  assert.equal(heuristicPlan('תשמיעי לי אותו', { video: clown }).intent, 'video_play');
  assert.equal(heuristicPlan('מה השם של הסרטון באנגלית', { video: clown }).intent, 'video_about');
  assert.equal(heuristicPlan('תחפשי באינטרנט מה שער הדולר היום').intent, 'web');
  assert.equal(heuristicPlan('תסבירי לי איך עובד מנוע').intent, 'chat');
  assert.equal(heuristicPlan('אני רוצה להוריד את הווידאו', { video: clown }).play, 'video');
});

test('vulgar titles are never offered', () => {
  assert.equal(isSafeVideo({ title: 'סליחה, אולי תמצצי לי?' }), false);
  assert.equal(isSafeVideo({ title: 'אני והציצים שלי' }), false);
  assert.equal(isSafeVideo({ title: 'Sully: the Miracle on the Hudson documentary' }), true);
});

test('durations', () => {
  assert.equal(parseIsoDuration('PT1H2M3S'), 3723);
  assert.equal(parseIsoDuration('PT29M'), 1740);
  assert.equal(spokenDuration(1740), '29 דקות');
  assert.equal(spokenDuration(3600), 'שעה');
});

function fakeYouTube(items) {
  return async url => {
    const u = new URL(url);
    if (u.pathname.endsWith('/search')) {
      assert.equal(u.searchParams.get('safeSearch'), 'strict');
      return { ok: true, status: 200, json: async () => ({ items: items.map(v => ({ id: { videoId: v.id } })) }) };
    }
    return { ok: true, status: 200, json: async () => ({ items: items.map(v => ({ id: v.id, snippet: { title: v.title, channelTitle: v.ch, description: 'desc ' + v.title, publishedAt: '2024-01-01T00:00:00Z' }, contentDetails: { duration: v.d }, statistics: { viewCount: String(v.views) } })) }) };
  };
}
const env = { YOUTUBE_API_KEY: 'k1' };

test('findVideos returns only real, safe results with real lengths', async () => {
  const out = await findVideos(['אסונות תעופה'], { env, fetchImpl: fakeYouTube([
    { id: 'aaaaaaaaaaa', title: 'Miracle on the Hudson full documentary', ch: 'Docs', d: 'PT52M', views: 900000 },
    { id: 'bbbbbbbbbbb', title: 'sex tape', ch: 'X', d: 'PT5M', views: 9 }
  ]) });
  assert.deepEqual(out.map(v => v.videoId), ['aaaaaaaaaaa']);
  assert.equal(out[0].durationSec, 3120);
});

const now = 'יום שלישי';
const baseDeps = (llmAnswers, extra = {}) => {
  const prompts = [];
  return { prompts, deps: { env, log: { info() {}, warn() {} }, llm: async (p, o) => { prompts.push({ p, o }); const a = llmAnswers.shift(); if (a instanceof Error) throw a; return a; }, webSearch: async () => [], ...extra } };
};

test('video recommendation names only a video that really exists', async () => {
  const { deps } = baseDeps([
    '{"intent":"video_find","standalone":"סרטון דוקו מותח","yt_he":"דוקו מותח","yt_en":"thrilling documentary"}',
    '{"pick":0,"answer":"ממליצה על True Crime Mysteries: The Invented Video"}' // invented: not in the list
  ], { fetchImpl: fakeYouTube([{ id: 'ccccccccccc', title: 'The Real Heist Documentary', ch: 'Real Docs', d: 'PT58M', views: 2000000 }]) });
  const r = await ext3Turn({ utterance: 'תמליצי לי על סרטון דוקו מותח ביוטיוב', now }, deps);
  assert.equal(r.ref.videoId, 'ccccccccccc');
  assert.match(r.reply, /The Real Heist Documentary/);
  assert.doesNotMatch(r.reply, /Invented/);
  assert.match(r.reply, /58 דקות/);
});

test('questions about the chosen video use its real data; "play it" hands off to extension 2', async () => {
  const current = [{ user: 'תמליצי', assistant: 'ממליצה על הסרטון', ref: clown }];
  const a = baseDeps(['{"intent":"video_about","standalone":"מה אורך הסרטון"}', '{"answer":"הסרטון The Killer Clown Case That Fooled Everyone נמשך 29 דקות"}']);
  const r1 = await ext3Turn({ utterance: 'כמה זמן הוא נמשך', current, now }, a.deps);
  assert.equal(r1.intent, 'video_about');
  assert.match(a.prompts[1].p, /29 דקות/);
  const b = baseDeps(['{"intent":"video_play","standalone":"להשמיע את הסרטון","play":"audio"}']);
  const r2 = await ext3Turn({ utterance: 'תשמיעי לי אותו', current, now }, b.deps);
  assert.equal(r2.handoff.videoId, 'abcdefghijk');
  assert.equal(r2.handoff.mode, 'audio');
  const c = baseDeps(['{"intent":"video_play","play":"video"}']);
  const r3 = await ext3Turn({ utterance: 'תורידי את הווידאו', current, now }, c.deps);
  assert.equal(r3.handoff.mode, 'video');
});

test('"yes" continues the lesson without spending a planner call', async () => {
  const { deps, prompts } = baseDeps(['{"answer":"שלב שני בשיעור"}']);
  const current = [{ user: 'אני רוצה ללמוד תכנות', assistant: 'שלב ראשון... רוצה שנמשיך?', ref: { type: 'lesson', topic: 'תכנות', step: 1 } }];
  const r = await ext3Turn({ utterance: 'כן', current, now }, deps);
  assert.equal(r.intent, 'chat');
  assert.equal(r.ref.step, 2);
  assert.equal(r.reply, 'שלב שני בשיעור');
  assert.equal(prompts.length, 1);
  assert.match(prompts[0].p, /המשיכי בדיוק משם/);
});

test('when the planner is down the rules still pick the right path', async () => {
  const { deps } = baseDeps([new Error('down'), '{"answer":"מנוע סילון דוחס אוויר"}']);
  const r = await ext3Turn({ utterance: 'תסבירי לי איך עובד מנוע סילון', now }, deps);
  assert.equal(r.intent, 'chat');
  assert.equal(r.reply, 'מנוע סילון דוחס אוויר');
});

test('asked about "the video" with none on record: a memory answer, not a new search', async () => {
  let searched = false;
  const { deps } = baseDeps(['{"intent":"video_about"}', '{"answer":"המלצתי על הסרטון X"}'], { findVideos: async () => { searched = true; return []; } });
  const r = await ext3Turn({ utterance: 'מה היה השם של הסרטון שהמלצת לי', now }, deps);
  assert.equal(r.intent, 'recall');
  assert.equal(searched, false);
});

test('"play it" is audio unless a video download is asked', async () => {
  const current = [{ user: 'x', assistant: 'y', ref: clown }];
  const a = baseDeps([]); const r1 = await ext3Turn({ utterance: 'תשמיעי לי אותו', current, now }, a.deps);
  assert.equal(r1.handoff.mode, 'audio');
  const b = baseDeps([]); const r2 = await ext3Turn({ utterance: 'תורידי לי את הווידאו שלו', current, now }, b.deps);
  assert.equal(r2.handoff.mode, 'video');
});

test('web answers are built from pages actually read', async () => {
  const { deps, prompts } = baseDeps(['{"intent":"web","search":"שער הדולר היום"}', '{"answer":"שער הדולר היום 3.70"}'], {
    webSearch: async () => [{ title: 'בנק ישראל', url: 'https://boi.org.il/x', snippet: 'קצר' }],
    readPages: async () => [{ url: 'https://boi.org.il/x', content: 'השער היציג של הדולר היום הוא 3.70 שקלים.'.repeat(5) }]
  });
  const r = await ext3Turn({ utterance: 'מה שער הדולר', now }, deps);
  assert.equal(r.reply, 'שער הדולר היום 3.70');
  assert.match(prompts[1].p, /השער היציג/);
});

test('choices are offered in the one format the call understands', async () => {
  const { deps, prompts } = baseDeps(['{"intent":"chat"}', '{"answer":"x"}']);
  await ext3Turn({ utterance: 'תלמדי אותי תכנות', now }, deps);
  assert.match(prompts[1].p, /הקש 1/);
});

test('numbered choices in an answer become real keys', () => {
  assert.deepEqual(parseKeyOptions('ללימוד קוד הקש 1, ללימוד פריסה הקש 2, ולתרגול הקש 3.'), { 1: 'ללימוד קוד', 2: 'ללימוד פריסה', 3: 'לתרגול' });
  assert.deepEqual(parseKeyOptions('הקש 1 ללימוד קוד, הקש 2 ללימוד בסיס נתונים'), { 1: 'ללימוד קוד', 2: 'ללימוד בסיס נתונים' });
  assert.deepEqual(parseKeyOptions('אפשרויות: 1. משתנים. 2. לולאות.'), { 1: 'משתנים', 2: 'לולאות' });
  assert.equal(parseKeyOptions('השעה 1 בצהריים'), null);
});

test('a pressed key continues with that choice, not the menu again', async () => {
  const { deps, prompts } = baseDeps(['{"answer":"נתחיל בלימוד פריסה"}']);
  const current = [{ user: 'תלמדי אותי', assistant: 'ללימוד קוד הקש 1, ללימוד פריסה הקש 2' }];
  const r = await ext3Turn({ utterance: 'בחרתי באפשרות 2: ללימוד פריסה', current, now }, deps);
  assert.equal(r.reply, 'נתחיל בלימוד פריסה');
  assert.equal(prompts.length, 1);
  assert.match(prompts[0].p, /המשיכי בדיוק משם/);
});
