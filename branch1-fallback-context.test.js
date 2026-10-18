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

test('single-input fallback prompt explicitly labels system guidance separately', async () => {
  const { formatBranch1FallbackPrompt } = await import('./branch1-fallback-context.js');
  assert.equal(
    formatBranch1FallbackPrompt('ענה בעברית', 'מה השעה?'),
    'System instructions:\\nענה בעברית\\n\\nConversation:\\nמה השעה?'
  );
});
