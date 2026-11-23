// Owner, 23.11: extension 4 as a menu (kind, content, voice, style, length),
// each choice said back with 1 = confirm / 2 = again.
import test from 'node:test';
import assert from 'node:assert/strict';
import { buildSongPrompt, createSongCallHandler } from '../song-ivr.js';

test('the menu choices become the request the engine understands', () => {
  const p = buildSongPrompt({ kind: '1', text: 'שבת קודש', voice: '2', style: '4', minutes: '2' });
  assert.match(p, /שיר על הנושא: שבת קודש/);
  assert.match(p, /בקול של ילד/);
  assert.match(p, /ראפ/);
  assert.match(p, /duration_seconds=120/);
  assert.match(buildSongPrompt({ kind: '2', text: 'לכה דודי', voice: '1', style: '1', minutes: '1' }), /המילים שהמתקשר הכתיב, בדיוק כפי שנאמרו: לכה דודי/);
  assert.match(buildSongPrompt({ kind: '3', ytTitle: 'שיר ידוע', voice: '3', style: '5', minutes: '4' }), /גרסה חדשה בהשראת השיר "שיר ידוע".*מילים חדשות ומקוריות/);
});

test('a whole call: topic, re-record, voice changed once, style, length, summary', async () => {
  const said = [];
  const taps = ['1', /*topic recorded*/ '2', /*record again*/ '1', '2', '2', /*voice: boy, then choose again*/ '1', '1', /*voice: man, confirm*/ '4', '1', /*rap*/ '2', '1', /*2 minutes*/ '1'];
  const words = ['חנוכה', 'שבת קודש'];
  const call = {
    callId: 'song-test',
    values: {},
    read: async (items, mode) => {
      said.push(items.map(x => x.data).join(' '));
      if (mode === 'record') return '/rec.wav';
      const k = taps.shift();
      if (k === undefined) throw new Error('call was disconnected');
      return k;
    },
    id_list_message: async () => {}, go_to_folder: async () => {}
  };
  let prompt = null;
  const handler = createSongCallHandler({
    yemotApi: { download_file: async () => ({ data: Buffer.from('x') }) },
    transcribePhoneAudio: async () => words.shift() || 'x',
    generateText: async p => { prompt = p; throw Object.assign(new Error('stop here'), { code: 'TEST' }); },
    sanitizeForYemot: x => x, withTimeout: p => p, getCallerNumber: () => '0500000000', logDetailedError: () => {}
  });
  await handler(call).catch(() => {});
  const joined = said.join('\n');
  assert.match(joined, /ליצירת שיר לפי נושא הקש 1. לשיר לפי מילים שלך הקש 2. לגרסה חדשה לשיר מיוטיוב הקש 3/);
  assert.match(joined, /הנושא שבחרת: חנוכה. לאישור הקש 1, לביטול והקלטה מחדש הקש 2/);
  assert.match(joined, /בחרת: ילד. לאישור הקש 1, לבחירה מחדש הקש 2/);
  assert.match(joined, /לסיכום: שיר על שבת קודש, זמר גבר, בסגנון ראפ, באורך שתי דקות/);
});

test('lyrics with real line breaks inside the JSON are still read (long songs)', async () => {
  process.env.SONG_EVENTS_FILE = '/tmp/song-events-test.json';
  const { generateSongSpec } = await import('../song-generator.js');
  const raw = '{"title":"שבת","language":"he","genre":"pop","mood":"happy","tempo":"120","duration_seconds":120,"lyrics":"[Verse 1]\nשבת שלום\nשבת המלכה\n[Chorus]\nלכה דודי","music_prompt":"happy pop, adult male lead vocals","needs_clarification":false}';
  const spec = await generateSongSpec({ prompt: 'שיר על שבת. אורך השיר: שתי דקות' }, async () => raw);
  assert.match(spec.lyrics, /שבת המלכה/);
  assert.equal(spec.durationSeconds, 120);
});
