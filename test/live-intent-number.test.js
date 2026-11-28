import test from 'node:test';
import assert from 'node:assert/strict';
import { findYoutubeLive } from '../live-intent.js';
test('a channel number must match: channel 14 is not channel 10', async () => {
  const execImpl = async () => JSON.stringify({ entries: [{ id: 'Hboq7RTjUYU', title: 'ערוץ 10 בשידור חי', channel: 'ערוץ 10' }, { id: 'lygQRmx45oo', title: 'עכשיו 14 I הצטרפו לשידור', channel: 'C14' }] });
  assert.equal((await findYoutubeLive('ערוץ 14', { execImpl })).url.slice(-11), 'lygQRmx45oo');
});
