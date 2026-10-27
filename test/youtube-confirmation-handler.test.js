import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import vm from 'node:vm';

test('production YouTube confirmation recognizes spoken yes and no', async () => {
  const source = await readFile(new URL('../server.js', import.meta.url), 'utf8');
  const extract = name => {
    const start = source.indexOf('function ' + name + '(text) {');
    assert.notEqual(start, -1, name + ' function exists');
    const end = source.indexOf('\n  }', start);
    assert.notEqual(end, -1, name + ' function closes');
    return vm.runInNewContext('(' + source.slice(start, end + 4) + ')');
  };
  const yes = extract('isYes'), no = extract('isNo');
  for (const answer of ['כן','כן בהחלט','כן תשמיע']) assert.equal(yes(answer),true,answer);
  for (const answer of ['לא','לא תודה','לא רוצה']) assert.equal(no(answer),true,answer);
  assert.equal(yes('לא'),false);
  assert.equal(no('כן'),false);
});
