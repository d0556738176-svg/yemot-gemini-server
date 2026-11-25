import test from 'node:test';
import assert from 'node:assert/strict';
import { allowedUrl } from '../owner-browser.js';
test('only the work sites can be opened', () => {
  for (const u of ['https://www.call2all.co.il/ym/', 'https://github.com/x', 'https://acemusic.ai/playground/api-key', 'https://ext2.176-97-205-41.sslip.io/'])
    assert.equal(allowedUrl(u), true, u);
  for (const u of ['https://www.youtube.com/', 'https://evilgithub.com/', 'https://github.com.evil.io/', 'file:///etc/passwd', 'javascript:alert(1)'])
    assert.equal(allowedUrl(u), false, u);
});
