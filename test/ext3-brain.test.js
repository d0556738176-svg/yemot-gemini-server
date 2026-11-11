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
  return { prompts, deps: { env, retryPauseMs: 0, log: { info() {}, warn() {} }, llm: async (p, o) => { prompts.push({ p, o }); const a = llmAnswers.shift(); if (a instanceof Error) throw a; return a; }, webSearch: async () => [], ...extra } };
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
  assert.equal(r2.confirm.videoId, 'abcdefghijk');
  assert.equal(r2.confirm.mode, 'audio');
  const c = baseDeps(['{"intent":"video_play","play":"video"}']);
  const r3 = await ext3Turn({ utterance: 'תורידי את הווידאו', current, now }, c.deps);
  assert.equal(r3.confirm.mode, 'video');
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
  assert.equal(r1.confirm.mode, 'audio');
  const b = baseDeps([]); const r2 = await ext3Turn({ utterance: 'תורידי לי את הווידאו שלו', current, now }, b.deps);
  assert.equal(r2.confirm.mode, 'video');
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

test('without own YouTube keys the extension-2 keys are used', async () => {
  const calls = [];
  const proxy = async (kind, params) => { calls.push(kind); return kind === 'search' ? { items: [{ id: { videoId: 'ddddddddddd' } }] } : { items: [{ id: 'ddddddddddd', snippet: { title: 'Real one', channelTitle: 'C' }, contentDetails: { duration: 'PT30M' }, statistics: { viewCount: '5' } }] }; };
  const out = await findVideos(['x y'], { env: {}, proxy });
  assert.deepEqual(calls, ['search', 'videos']);
  assert.equal(out[0].videoId, 'ddddddddddd');
});

test('busy models: a smaller retry, and web never answers with unrelated junk', async () => {
  const { deps } = baseDeps(['{"intent":"web","search":"שער היורו"}', new Error('busy'), new Error('busy')], {
    webSearch: async () => [{ title: 'בנק ישראל', url: 'https://boi.org.il/a', snippet: 'השער היציג של היורו היום הוא 3.65 שקלים חדשים לפי בנק ישראל.' }]
  });
  const r = await ext3Turn({ utterance: 'מה שער היורו היום', now }, deps);
  assert.match(r.reply, /3\.65/);
  const b = baseDeps(['{"intent":"chat"}', new Error('busy'), '{"answer":"תשובה אחרי המתנה"}']);
  const r2 = await ext3Turn({ utterance: 'ספרי לי על ירושלים', now }, b.deps);
  assert.equal(r2.reply, 'תשובה אחרי המתנה');
});

test('play: never downloads, says the full title and offers keys 1/2/3', async () => {
  const current = [{ user: 'x', assistant: 'y', ref: clown }];
  const { deps } = baseDeps([]);
  const r = await ext3Turn({ utterance: 'תשמיעי לי אותו', current, now }, deps);
  assert.equal(r.handoff, undefined);
  assert.ok(r.confirm);
  assert.match(r.reply, /The Killer Clown Case That Fooled Everyone/);
  assert.match(r.reply, /קובץ שמע הקש 1/);
  assert.match(r.reply, /וידאו הקש 2/);
  assert.match(r.reply, /לביטול והמשך השיחה הקש 3/);
});

test('play by name searches the named song, not the old active video', async () => {
  const current = [{ user: 'x', assistant: 'y', ref: clown }];
  let asked = null;
  const found = { videoId: 'zzzzzzzzzzz', title: 'אושר כהן - דאון', channelTitle: 'Osher Cohen', durationSec: 200, viewCount: 1000, description: '' };
  const { deps } = baseDeps([], { findVideos: async q => { asked = q; return [found]; } });
  const r = await ext3Turn({ utterance: 'תשמיעי לי את אושר כהן דאון', current, now }, deps);
  assert.equal(r.confirm.videoId, 'zzzzzzzzzzz');
  assert.match(asked[0], /אושר כהן/);
  assert.doesNotMatch(asked[0], /תשמיעי/);
});

test('status and cancel questions are flagged for the server, no model call', async () => {
  const a = baseDeps([]); const r1 = await ext3Turn({ utterance: 'מה מצב ההורדה?', now }, a.deps);
  assert.equal(r1.mediaStatus, true); assert.equal(a.prompts.length, 0);
  const b = baseDeps([]); const r2 = await ext3Turn({ utterance: 'לא, תעצור, אני לא רוצה שיוריד', now }, b.deps);
  assert.equal(r2.cancel, true); assert.equal(b.prompts.length, 0);
});

test('an article is read in parts and "continue" reads the next part', async () => {
  const body = Array.from({ length: 60 }, (_, i) => 'זה משפט מספר ' + i + ' בכתבה המחזקת על אמונה ובטחון בבורא עולם.').join('\n');
  const { deps } = baseDeps(['{"intent":"read_page","search":"כתבה מחזקת הידברות"}'], {
    webSearch: async () => [{ title: 'כתבה מחזקת', url: 'https://www.hidabroot.org/article/12345', snippet: '' }],
    readPages: async () => [{ url: 'https://www.hidabroot.org/article/12345', content: body }]
  });
  const r1 = await ext3Turn({ utterance: 'תקריאי לי כתבה מחזקת מאתר הידברות', now }, deps);
  assert.equal(r1.ref.type, 'article');
  assert.match(r1.reply, /hidabroot\.org/);
  assert.match(r1.reply, /משפט מספר 0/);
  const r2 = await ext3Turn({ utterance: 'תמשיכי', now, current: [{ user: 'a', assistant: r1.reply, ref: r1.ref }] }, deps);
  assert.ok(r2.ref.pos > r1.ref.pos);
  assert.doesNotMatch(r2.reply, /משפט מספר 0 /);
});

test('a standing instruction is returned so it can be kept', async () => {
  const { deps } = baseDeps(['{"intent":"chat"}', '{"answer":"בסדר, לא אדבר על זה"}']);
  const r = await ext3Turn({ utterance: 'מעכשיו אל תדברי איתי על פוליטיקה', now }, deps);
  assert.match(r.instruction, /פוליטיקה/);
});

test('official sites rank before news and social pages', async () => {
  const { sourceRank } = await import('../ext3-brain.js');
  assert.equal(sourceRank('https://www.clalit.co.il/he/x'), 0);
  assert.equal(sourceRank('https://www.ynet.co.il/x'), 1);
  assert.equal(sourceRank('https://www.facebook.com/x'), 3);
});

test('a new name beats the old video even when the planner points at the old one', async () => {
  const prior = [{ user: 'x', assistant: 'y', ref: clown }];
  let asked = null;
  const found = { videoId: 'downdowndow', title: 'אושר כהן - דאון', channelTitle: 'Osher Cohen', durationSec: 190, viewCount: 5, description: '' };
  const { deps } = baseDeps(['{"intent":"video_play","yt_he":"","instruction":"המתקשר מבקש להאזין לסרטון"}'], { findVideos: async q => { asked = q; return [found]; } });
  const r = await ext3Turn({ utterance: 'תשמיעי לי את אושר כהן דאון', prior, now }, deps);
  assert.equal(r.confirm.videoId, 'downdowndow');
  assert.match(asked[0], /דאון/);
  assert.equal(r.instruction, undefined);
});

test('stuck: a numbered list becomes real key options', async () => {
  const { numberedToKeys, parseKeyOptions } = await import('../ext3-brain.js');
  const k = parseKeyOptions(numberedToKeys('נושאים, 1, משתנים, 2, תנאים, 3, לולאות'));
  assert.deepEqual(Object.keys(k), ['1', '2', '3']);
  assert.match(k['3'], /ללולאות/);
});

test('stray Chinese words are removed from a Hebrew answer', async () => {
  const { deps } = baseDeps(['{"intent":"chat"}', '{"answer":"לא אדבר על זה בשיחות未来的 שלך"}']);
  const r = await ext3Turn({ utterance: 'תסבירי לי משהו על חשמל', now }, deps);
  assert.doesNotMatch(r.reply, /[　-鿿]/);
});

test('article search skips section pages and uses the site he named', async () => {
  const { deps } = baseDeps(['{"intent":"read_page","search":"כתבה מחזקת הידברות"}'], {
    webSearch: async () => [{ title: 'חדשות היום', url: 'https://www.hidabroot.org/news', snippet: '' }, { title: 'כתבה מאתר אחר', url: 'https://other.co.il/article/77777', snippet: '' }, { title: 'הכוח של אמונה', url: 'https://www.hidabroot.org/article/99999', snippet: '' }],
    readPages: async urls => urls.map(u => ({ url: u, content: Array.from({ length: 20 }, (_, i) => 'משפט ' + i + ' על כוחה של האמונה בחיי היום יום של כל יהודי.').join('\n') }))
  });
  const r = await ext3Turn({ utterance: 'תקריאי לי כתבה מחזקת מאתר הידברות', now }, deps);
  assert.equal(r.ref.url, 'https://www.hidabroot.org/article/99999');
});

test('a song by the same artist is not taken for the one he named', async () => {
  const current = [{ user: 'x', assistant: 'y', ref: { type: 'video', videoId: 'eyneotieyne', title: 'אושר כהן ונועה קירל - אין אותי', channelTitle: 'Osher Cohen Music', durationSec: 240 } }];
  const found = { videoId: 'downdowndow', title: 'אושר כהן - דאון', channelTitle: 'Osher Cohen', durationSec: 190, viewCount: 5, description: '' };
  const { deps } = baseDeps([], { findVideos: async () => [found] });
  const r = await ext3Turn({ utterance: 'תשמיעי לי את אושר כהן דאון', current, now }, deps);
  assert.equal(r.confirm.videoId, 'downdowndow');
});

test('a standing rule gets a clear acknowledgement and is returned', async () => {
  const { deps } = baseDeps(['{"intent":"chat","instruction":"לא לדבר על פוליטיקה"}']);
  const r = await ext3Turn({ utterance: 'מעכשיו אל תדברי איתי על פוליטיקה בכלל', now }, deps);
  assert.match(r.reply, /אקפיד/);
  assert.equal(r.instruction, 'לא לדבר על פוליטיקה');
});
