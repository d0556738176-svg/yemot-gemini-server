import test from 'node:test';
import assert from 'node:assert/strict';
import { withHashExtension, HASH_INI } from '../hash-callback.js';

test('main menu gets hash_extension=yes and keeps its other lines', () => {
  assert.equal(withHashExtension('type=menu\r\n'), 'type=menu\nhash_extension=yes\n');
  assert.equal(withHashExtension('type=menu\nhash_extension=no\ntitle=x'), 'type=menu\ntitle=x\nhash_extension=yes\n');
  assert.equal(withHashExtension(withHashExtension('type=menu')), 'type=menu\nhash_extension=yes\n');
});

test('callback folder calls the caller back from the number he dialed', () => {
  assert.match(HASH_INI, /^type=system_sharing$/m);
  assert.match(HASH_INI, /^system_sharing_to_myself=yes$/m);
  assert.match(HASH_INI, /^system_sharing_custom_did=real_did$/m);
});
