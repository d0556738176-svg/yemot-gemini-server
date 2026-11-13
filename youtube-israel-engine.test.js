import test from 'node:test';
import assert from 'node:assert/strict';
import { pickApifyActor } from './youtube-engine-select.js';
import { ISRAEL_ACTOR, israelRunInput, ISRAEL_ACTOR_FILES } from './youtube-israel-engine.js';

test('a video allowed only in Israel goes to the Israel engine; any other to the normal engine', async () => {
  const il = await pickApifyActor('abcdefghijk', { YOUTUBE_API_KEY: 'k' }, { fetchVideoFacts: async () => ({ regionAllowed: ['IL'], regionBlocked: null, durationSeconds: 90 }) });
  assert.equal(il.actor, ISRAEL_ACTOR);
  const normal = await pickApifyActor('abcdefghijk', { YOUTUBE_API_KEY: 'k' }, { fetchVideoFacts: async () => ({ regionAllowed: null, regionBlocked: null }) });
  assert.notEqual(normal.actor, ISRAEL_ACTOR);
  const off = await pickApifyActor('abcdefghijk', { BRANCH2_ISRAEL_ENGINE: 'off' }, { fetchVideoFacts: async () => ({ regionAllowed: ['IL'] }) });
  assert.notEqual(off.actor, ISRAEL_ACTOR);
  const unknown = await pickApifyActor('abcdefghijk', {}, { fetchVideoFacts: async () => { throw new Error('x'); } });
  assert.notEqual(unknown.actor, ISRAEL_ACTOR);
});

test('the Israel engine always asks for an Israeli exit and checks it', () => {
  assert.deepEqual(israelRunInput('abcdefghijk'), { videoId: 'abcdefghijk', mode: 'audio', country: 'IL', maxHeight: 720 });
  const main = ISRAEL_ACTOR_FILES.find(f => f.name === 'main.py').content;
  assert.match(main, /country_code=country/);
  assert.match(main, /ip\.get\('country'\) != country/);
});
