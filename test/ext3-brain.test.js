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
  assert.match(r.reply, /וידאו עם אפשרות לכתובית בעברית הקש 2/);
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

test('"from now on don\'t talk about X" is a rule, not a cancel', async () => {
  const { deps } = baseDeps(['{"intent":"cancel"}']);
  const r = await ext3Turn({ utterance: 'מעכשיו אל תדברי איתי על פוליטיקה בכלל', now }, deps);
  assert.equal(r.cancel, undefined);
  assert.match(r.instruction, /פוליטיקה/);
  assert.match(r.reply, /אקפיד/);
});

test('a named song keeps its own versions, original first', async () => {
  const { findVideos } = await import('../ext3-brain.js');
  const items = [
    { id: 'aaaaaaaaaaa', snippet: { title: 'אושר כהן - דאון (קריוקי פסנתר)', channelTitle: 'k' }, contentDetails: { duration: 'PT4M' }, statistics: { viewCount: '100' } },
    { id: 'bbbbbbbbbbb', snippet: { title: 'אושר כהן - הכלה של המדינה', channelTitle: 'o' }, contentDetails: { duration: 'PT4M' }, statistics: { viewCount: '9000000' } },
    { id: 'ccccccccccc', snippet: { title: 'אושר כהן - דאון', channelTitle: 'o' }, contentDetails: { duration: 'PT3M' }, statistics: { viewCount: '50000' } },
    { id: 'ddddddddddd', snippet: { title: 'אושר כהן - דאון (Remix)', channelTitle: 'dj' }, contentDetails: { duration: 'PT4M' }, statistics: { viewCount: '80000' } }
  ];
  const fetchImpl = async url => ({ ok: true, json: async () => String(url).includes('/search') ? { items: items.map(i => ({ id: { videoId: i.id } })) } : { items } });
  const found = await findVideos(['אושר כהן דאון'], { env: { YOUTUBE_API_KEY: 'k' }, fetchImpl });
  assert.equal(found[0].videoId, 'ccccccccccc');
  assert.ok(!found.some(v => v.videoId === 'bbbbbbbbbbb'));
});

test('extension 1: man\'s voice and short answers', async () => {
  const { deps, prompts } = baseDeps(['{"intent":"chat"}', '{"answer":"אני ממליצה לך לנוח"}']);
  const r = await ext3Turn({ utterance: 'מה כדאי לעשות כשעייפים', now, voice: 'male', brief: true }, deps);
  assert.equal(r.reply, 'אני ממליץ לך לנוח');
  assert.match(prompts.at(-1).p, /ענה בקצרה, 2 עד 4 משפטים/);
  assert.match(prompts.at(-1).p, /בלשון זכר/);
  const current = [{ user: 'x', assistant: 'y', ref: clown }];
  const b = baseDeps([]); const c = await ext3Turn({ utterance: 'תשמיעי לי אותו', current, now, voice: 'male', brief: true }, b.deps);
  assert.match(c.reply, /לפני שאני מוריד,/);
});

const libSongs = [
  { videoId: 'downdowndow', title: 'אושר כהן - דאון', path: '/7/012', at: '2026-11-10T10:00:00Z' },
  { videoId: 'kupakupakup', title: 'קופה ראשית - פרק 5 עונה 4', path: '/7/013', at: '2026-11-11T10:00:00Z' }
];

test('a downloaded song plays at once, with no confirmation and no download', async () => {
  let searched = false;
  const { deps } = baseDeps([], { library: async () => libSongs, findVideos: async () => { searched = true; return []; } });
  const r = await ext3Turn({ utterance: 'תשמיעי לי את אושר כהן דאון', now }, deps);
  assert.deepEqual(r.play.paths, ['/7/012']);
  assert.equal(r.confirm, undefined);
  assert.equal(searched, false);
  assert.match(r.reply, /כבר שמור/);
});

test('"download it again" skips the library and asks to confirm', async () => {
  const found = { videoId: 'downdowndow', title: 'אושר כהן - דאון', channelTitle: 'o', durationSec: 190, viewCount: 5, description: '' };
  const { deps } = baseDeps([], { library: async () => libSongs, findVideos: async () => [found] });
  const r = await ext3Turn({ utterance: 'תורידי שוב את אושר כהן דאון', now }, deps);
  assert.ok(r.confirm);
  assert.equal(r.play, undefined);
});

test('the list of downloaded songs comes with keys', async () => {
  const { deps } = baseDeps([], { library: async () => libSongs });
  const r = await ext3Turn({ utterance: 'אילו שירים כבר הורדתי?', now }, deps);
  assert.match(r.reply, /לשמיעת קופה ראשית - פרק 5 עונה 4 הקש 1/);
  assert.match(r.reply, /לשמיעת אושר כהן - דאון הקש 2/);
});

test('a key choice that names a song plays it', async () => {
  const { deps } = baseDeps([], { library: async () => libSongs });
  const r = await ext3Turn({ utterance: 'בחרתי באפשרות 2: לשמיעת אושר כהן - דאון', now }, deps);
  assert.deepEqual(r.play.paths, ['/7/012']);
});

test('stock openings are cut from answers', async () => {
  const { deps } = baseDeps(['{"intent":"chat"}', '{"answer":"שמחתי לשמוע שאתה מתעניין! מקרר עובד בעזרת מדחס שדוחס גז קירור."}']);
  const r = await ext3Turn({ utterance: 'איך עובד מקרר', now }, deps);
  assert.match(r.reply, /^מקרר עובד/);
});

test('news questions use real headlines', async () => {
  let asked = '';
  const { deps, prompts } = baseDeps(['{"intent":"web","search":"חדשות היום"}', '{"answer":"הידיעה המרכזית היום היא שהכנסת אישרה את התקציב."}'], {
    newsSearch: async q => { asked = q; return [1, 2, 3, 4].map(i => ({ title: 'ידיעה ' + i, snippet: 'פרטים ' + i, source: 'ynet', date: 'לפני שעה' })); }
  });
  const r = await ext3Turn({ utterance: 'מה החדשות היום בארץ?', now }, deps);
  assert.ok(asked);
  assert.match(prompts.at(-1).p, /ידיעה 1/);
  assert.match(r.reply, /התקציב/);
});

test('"recommend a new song" stays a YouTube search', async () => {
  let searched = null;
  const found = { videoId: 'shwekeynew1', title: 'יעקב שוואקי - שיר חדש', channelTitle: 'Shwekey', durationSec: 240, viewCount: 1000, description: '' };
  const { deps } = baseDeps(['{"intent":"web","search":"שיר חדש שוואקי"}', '{"pick":0,"answer":"מצאתי לך את יעקב שוואקי - שיר חדש"}'], { findVideos: async q => { searched = q; return [found]; } });
  const r = await ext3Turn({ utterance: 'תמליצי לי על שיר חדש של יעקב שוואקי', now }, deps);
  assert.ok(searched);
  assert.equal(r.ref.videoId, 'shwekeynew1');
});

test('extension 3 may give a real compliment now and then, extension 1 never', async () => {
  const turns = [{ user: 'a', assistant: 'b' }, { user: 'c', assistant: 'd' }];
  const a = baseDeps(['{"intent":"chat"}', '{"answer":"תשובה מלאה על המטוס"}']);
  await ext3Turn({ utterance: 'איך עובד מטוס', current: turns, now }, a.deps);
  assert.match(a.prompts.at(-1).p, /מחמאה קצרה וכנה/);
  const b = baseDeps(['{"intent":"chat"}', '{"answer":"תשובה"}']);
  await ext3Turn({ utterance: 'איך עובד מטוס', current: turns, now, voice: 'male', brief: true }, b.deps);
  assert.doesNotMatch(b.prompts.at(-1).p, /מחמאה/);
  const c = baseDeps(['{"intent":"chat"}', '{"answer":"תשובה"}']);
  await ext3Turn({ utterance: 'איך עובד מטוס', current: [turns[0]], now }, c.deps);
  assert.doesNotMatch(c.prompts.at(-1).p, /מחמאה/);
});

test('a speaking style is switched on, followed in answers, and switched off', async () => {
  const { STYLE_PREFIX } = await import('../ext3-brain.js');
  const a = baseDeps([]);
  const on = await ext3Turn({ utterance: 'מעכשיו תדברי איתי באופן עוקצני', now }, a.deps);
  assert.ok(on.instruction.startsWith(STYLE_PREFIX));
  assert.match(on.reply, /עוקצנית/);
  assert.equal(a.prompts.length, 0);
  const b = baseDeps(['{"intent":"chat"}', '{"answer":"נו באמת, מטוס עף בזכות הכנפיים."}']);
  await ext3Turn({ utterance: 'איך עובד מטוס', now, prefs: [on.instruction] }, b.deps);
  assert.match(b.prompts.at(-1).p, /בסגנון הזה/);
  const off = await ext3Turn({ utterance: 'תדברי איתי רגיל', now, prefs: [on.instruction] }, baseDeps([]).deps);
  assert.equal(off.styleReset, true);
  assert.match(off.reply, /רגיל/);
});

test('13.11: subject words, not "full / newest / find me on YouTube"', async () => {
  const { ytSubject, cleanTitle, NEWEST } = await import('../ext3-brain.js');
  assert.equal(ytSubject('ארץ נהדרת תמצאי לי ביוטיוב באורך מלא הכי חדש'), 'ארץ נהדרת');
  assert.equal(ytSubject('ארץ נהדרת פרק מלא חדש'), 'ארץ נהדרת פרק');
  assert.ok(NEWEST.test('ארץ נהדרת הפרק האחרון'));
  const t = cleanTitle('ElaytZur Aviv alush Stam Tamim אלייצור ואביב אלוש סתם תמים , Prod. by N.B.G X Shay Vagus');
  assert.ok(!/[,.]/.test(t) && !/Prod/i.test(t), t);
  assert.match(t, /סתם תמים/);
});

test('13.11: "newest full episode" -> newest long match, even without the words in the title', async () => {
  const items = [
    { id: 'promo000001', snippet: { title: 'ארץ נהדרת | פרומו', channelTitle: 'keshet', publishedAt: '2026-11-10T00:00:00Z' }, contentDetails: { duration: 'PT1M' }, statistics: { viewCount: '5000' } },
    { id: 'old00000001', snippet: { title: 'ארץ נהדרת עונה 22 פרק 3', channelTitle: 'keshet', publishedAt: '2025-01-01T00:00:00Z' }, contentDetails: { duration: 'PT45M' }, statistics: { viewCount: '900000' } },
    { id: 'new00000001', snippet: { title: 'ארץ נהדרת | עונה 23 פרק 5', channelTitle: 'keshet', publishedAt: '2026-11-01T00:00:00Z' }, contentDetails: { duration: 'PT44M' }, statistics: { viewCount: '20000' } },
    { id: 'other000001', snippet: { title: 'פודקאסט על טלוויזיה', channelTitle: 'pod', publishedAt: '2026-11-12T00:00:00Z' }, contentDetails: { duration: 'PT60M' }, statistics: { viewCount: '100' } }
  ];
  const queries = [];
  const fetchImpl = async url => { if (String(url).includes('/search')) queries.push(new URL(url).searchParams.get('q')); return { ok: true, json: async () => String(url).includes('/search') ? { items: items.map(i => ({ id: { videoId: i.id } })) } : { items } }; };
  const found = await findVideos(['ארץ נהדרת פרק מלא הכי חדש'], { minMinutes: 20, order: 'date', env: { YOUTUBE_API_KEY: 'k' }, fetchImpl });
  assert.equal(found[0].videoId, 'new00000001');
  assert.ok(!found.some(v => v.videoId === 'promo000001' || v.videoId === 'other000001'));
  assert.ok(queries.every(q => !/מלא|חדש/.test(q)), queries.join('|'));
});

test('13.11: the library list gives structured key choices with clean titles', async () => {
  const lib = [{ videoId: 'stamtamim01', title: 'Stam Tamim סתם תמים , Prod. by N.B.G', path: '/7/020', at: '2026-11-12T10:00:00Z' }, ...libSongs];
  const { deps } = baseDeps([], { library: async () => lib });
  const r = await ext3Turn({ utterance: 'איזה שירים כבר הורדתי', now }, deps);
  assert.equal(r.choices['1'].item.path, '/7/020');
  assert.equal(r.choices['1'].type, 'play');
  assert.ok(!/Prod/.test(r.reply));
  const keys = parseKeyOptions(r.reply);
  assert.deepEqual(Object.keys(keys).sort(), ['1', '2', '3']);
});

test('13.11: a video recommendation offers the other options by key', async () => {
  const vids = ['a', 'b', 'c'].map((x, i) => ({ videoId: x.repeat(11), title: 'ארץ נהדרת פרק ' + (i + 1), channelTitle: 'keshet', durationSec: 2700, viewCount: 100, publishedAt: '2026-11-01', description: '' }));
  const { deps } = baseDeps(['{"intent":"video_find","yt_he":"ארץ נהדרת","min_minutes":20}', '{"pick":0,"answer":"מצאתי את ארץ נהדרת פרק 1, בערוץ keshet."}'], { findVideos: async () => vids });
  const r = await ext3Turn({ utterance: 'תמצאי לי ביוטיוב את ארץ נהדרת באורך מלא הכי חדש', now }, deps);
  assert.equal(r.intent, 'video_find');
  assert.equal(r.choices['2'].video.videoId, 'bbbbbbbbbbb');
  assert.match(r.reply, /הקש 3/);
});

test('13.11: nothing long found -> the closest one, said honestly', async () => {
  const short = { videoId: 'shortshort1', title: 'ארץ נהדרת מערכון', channelTitle: 'keshet', durationSec: 300, viewCount: 100, publishedAt: '2026-11-01', description: '' };
  const calls = [];
  const { deps, prompts } = baseDeps(['{"intent":"video_find","yt_he":"ארץ נהדרת","min_minutes":20}', '{"pick":0,"answer":"פרקים מלאים לא מצאתי. הכי קרוב: ארץ נהדרת מערכון"}'], { findVideos: async (q, o) => { calls.push(o); return o.minMinutes ? [] : [short]; } });
  const r = await ext3Turn({ utterance: 'ארץ נהדרת באורך מלא', now }, deps);
  assert.equal(r.ref.videoId, 'shortshort1');
  assert.match(prompts.at(-1).p, /לא נמצא ביוטיוב סרטון באורך מלא/);
});

const gospel = { type: 'video', videoId: 'gospelgosp1', title: 'LIGHT OF THE WORLD Gospel Fest', channelTitle: 'x', durationSec: 120 };
test('13.11: "the song" from a web answer is not an old video from turns ago', async () => {
  const current = [{ user: 'a', assistant: 'b', ref: gospel }, { user: 'c', assistant: 'd' }, { user: 'מה השיר הראשון במצעד', assistant: 'במקום הראשון במצעד נמצא השיר של אייל גולן' }];
  const found = { videoId: 'eyalgolan01', title: 'אייל גולן - השיר החדש', channelTitle: 'Eyal Golan', durationSec: 200, viewCount: 1000 };
  let asked = '';
  const { deps } = baseDeps(['{"intent":"video_play","yt_he":"אייל גולן השיר החדש"}'], { findVideos: async q => { asked = q[0]; return [found]; } });
  const r = await ext3Turn({ utterance: 'תורידי לי את השיר הזה', current, now }, deps);
  assert.equal(asked, 'אייל גולן השיר החדש');
  assert.equal(r.confirm.videoId, 'eyalgolan01');
});

test('13.11: "play it" right after a recommendation is that exact video, even as the phone mishears it', async () => {
  for (const said of ['תשמיעי לי אותו', 'תשמעי לי אותו', 'תשמילי אותו', 'נו תשמירי לי אותו', 'תשמיעלי את זה']) {
    const current = [{ user: 'תמצאי לי שיר', assistant: 'מצאתי', ref: clown }];
    const { deps, prompts } = baseDeps([], { findVideos: async () => { throw new Error('no search'); } });
    const r = await ext3Turn({ utterance: said, current, now }, deps);
    assert.equal(r.confirm?.videoId, clown.videoId, said);
    assert.equal(prompts.length, 0, said + ': no model needed');
  }
});

test('13.11: "the second one" picks the second option read to him', async () => {
  const opts = ['aaaaaaaaaaa', 'bbbbbbbbbbb', 'ccccccccccc'].map((id, i) => ({ type: 'video', videoId: id, title: 'אפשרות ' + (i + 1), channelTitle: 'c', durationSec: 60 }));
  const current = [{ user: 'x', assistant: 'y', ref: { ...opts[0], options: opts } }];
  const { deps } = baseDeps([]);
  const r = await ext3Turn({ utterance: 'תשמיעי לי את השני', current, now }, deps);
  assert.equal(r.confirm.videoId, 'bbbbbbbbbbb');
});

test('13.11: "the episode you said you found" returns to it instead of a new search', async () => {
  const current = [{ user: 'x', assistant: 'מצאתי', ref: clown }, { user: 'y', assistant: 'לא מצאתי' }, { user: 'z', assistant: 'לא מצאתי' }];
  const { deps } = baseDeps(['{"intent":"video_find","yt_he":"ארץ נהדרת פרק מלא"}'], { findVideos: async () => { throw new Error('no search'); } });
  const r = await ext3Turn({ utterance: 'לא, אני רוצה את הפרק שאמרת לפני כן', current, now }, deps);
  assert.equal(r.ref.videoId, clown.videoId);
  assert.match(r.reply, /The Killer Clown/);
});

test('13.11: two things to look up in one sentence -> a search for each, and both reach the answer', async () => {
  const searched = [];
  const { deps, prompts } = baseDeps(['{"intent":"web","search":"מזג אוויר ירושלים","searches":[]}', '{"answer":"בירושלים 20 מעלות, והדולר 3.6 שקלים"}'], {
    webSearch: async q => { searched.push(q); return /דולר/.test(q) ? [{ url: 'https://www.boi.org.il/x/12345', title: 'שער הדולר', snippet: 'הדולר 3.6' }] : [{ url: 'https://ims.gov.il/he/forecast/12345', title: 'תחזית', snippet: '20 מעלות' }]; }
  });
  const r = await ext3Turn({ utterance: 'תגידי לי מה מזג האוויר בירושלים וגם כמה עולה דולר היום', now }, deps);
  assert.equal(searched.length, 2);
  assert.match(prompts.at(-1).p, /שער הדולר/);
  assert.match(prompts.at(-1).p, /עני על כל אחד מהם בנפרד/);
  assert.match(r.reply, /דולר/);
});
