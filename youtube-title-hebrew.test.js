import test from 'node:test';
import assert from 'node:assert/strict';
import { hebrewizeResults, spokenTitle, spokenChannel, needsHebrew } from './youtube-title-hebrew.js';
import { selectedResultIndex } from './youtube-selection.js';

test('non-Hebrew results are read in Hebrew and can be chosen by the Hebrew name', async () => {
  const page = [
    { videoId: 'aaaaaaaaaaa', title: 'How does an Electric Car work? | Tesla Model S', channelTitle: 'Learn Engineering' },
    { videoId: 'bbbbbbbbbbb', title: 'מוטי שטיינמץ - הנשמה בקרבי', channelTitle: 'Motty Steinmetz' },
  ];
  let sent = null;
  const fetchImpl = async (url, opts) => { sent = JSON.parse(JSON.parse(opts.body).messages[1].content); return new Response(JSON.stringify({ choices: [{ message: { content: '[{"t":"איך עובדת מכונית חשמלית? טסלה מודל S","c":"לרן אנג\'ינירינג","l":"אנגלית"},{"t":"מוטי שטיינמץ - הנשמה בקרבי","c":"מוטי שטיינמץ","l":"עברית"}]' } }] }), { status: 200 }); };
  await hebrewizeResults(page, { env: { GROQ_API_KEY: 'g' }, fetchImpl, log: {} });
  assert.equal(sent.length, 2); // the Hebrew title is sent only for its English channel name
  assert.equal(spokenTitle(page[0]), 'איך עובדת מכונית חשמלית? טסלה מודל S, סרטון באנגלית');
  assert.equal(spokenChannel(page[0]), "לרן אנג'ינירינג");
  assert.equal(spokenTitle(page[1]), 'מוטי שטיינמץ - הנשמה בקרבי');
  assert.equal(page[0].title, 'How does an Electric Car work? | Tesla Model S'); // original kept
  assert.equal(selectedResultIndex('מכונית חשמלית טסלה', page), 0);
  assert.ok(!needsHebrew({ title: 'שיר חדש' }));
});

test('when translation is unavailable the original title is read', async () => {
  const v = [{ videoId: 'ccccccccccc', title: 'Some English Title', channelTitle: 'X' }];
  await hebrewizeResults(v, { env: {}, log: {} });
  assert.equal(spokenTitle(v[0]), 'Some English Title');
});

test('a Hebrew title keeps its words; an English channel is read in Hebrew letters', async () => {
  const v = [{ videoId: 'ddddddddddd', title: 'אברהם פריד שבת קודש', channelTitle: 'Mor Zino' }];
  const fetchImpl = async () => new Response(JSON.stringify({ choices: [{ message: { content: '[{"t":"אברהם פריד - שבת קודש","c":"מור זינו","l":"עברית"}]' } }] }), { status: 200 });
  await hebrewizeResults(v, { env: { GROQ_API_KEY: 'g' }, fetchImpl, log: {} });
  assert.equal(spokenTitle(v[0]), 'אברהם פריד שבת קודש');
  assert.equal(spokenChannel(v[0]), 'מור זינו');
});
