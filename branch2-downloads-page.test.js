import test from 'node:test';
import assert from 'node:assert/strict';
import { allowedPath, niceName, contentDisposition } from './branch2-downloads-page.js';

test('download page names and paths', () => {
  assert.equal(niceName('מוטי_שטיינמץ_הנשמה_בקרבי.flac'), 'מוטי שטיינמץ הנשמה בקרבי.flac');
  const cd = contentDisposition('מוטי שטיינמץ.flac');
  assert.match(cd, /filename\*=UTF-8''%D7%9E%D7%95%D7%98%D7%99%20/);
  assert.ok(allowedPath('ivr2:/אודיו/x.flac'));
  assert.ok(allowedPath('ivr2:/וידאו_2/x.mp4'));
  assert.ok(!allowedPath('ivr2:/2/x.wav'));
  assert.ok(!allowedPath('ivr2:/אודיו/../1/ext.ini'));
  assert.ok(!allowedPath('ivr2:/אודיו/sub/x.flac'));
});
