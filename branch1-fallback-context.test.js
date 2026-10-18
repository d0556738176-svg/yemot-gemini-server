import test from 'node:test';
import assert from 'node:assert/strict';
import { buildBranch1FallbackMessages } from './branch1-fallback-context.js';

test('independent fallback preserves the system instructions and user text', () => {
  assert.deepEqual(
    buildBranch1FallbackMessages('  ענה בעברית טבעית  ', '  מה מזג האוויר?  '),
    [
      { role: 'system', content: 'ענה בעברית טבעית' },
      { role: 'user', content: 'מה מזג האוויר?' }
    ]
  );
});

test('empty system instructions are omitted and user text remains intact', () => {
  assert.deepEqual(
    buildBranch1FallbackMessages('', 'שלום'),
    [{ role: 'user', content: 'שלום' }]
  );
});

test('empty input does not create blank messages', () => {
  assert.deepEqual(buildBranch1FallbackMessages('  ', '  '), []);
});
