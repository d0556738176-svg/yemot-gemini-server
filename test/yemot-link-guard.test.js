import test from 'node:test';
import assert from 'node:assert/strict';
import { linkTargets, rewriteIni, guardOnce } from '../yemot-link-guard.js';

const t = linkTargets('https://main.88-214-55-82.sslip.io/');
test('ext2 target is derived from the main host', () => {
  assert.equal(t.main, 'https://main.88-214-55-82.sslip.io');
  assert.equal(t.ext2, 'https://ext2.88-214-55-82.sslip.io');
});
test('main and extension-2 Render links are moved back', () => {
  assert.equal(rewriteIni('type=api\napi_link=https://yemot-gemini-server.onrender.com/yemot-backup\nvoice=Osnat\n', t),
    'type=api\napi_link=https://main.88-214-55-82.sslip.io/yemot-backup\nvoice=Osnat\n');
  assert.equal(rewriteIni('api_link=https://yemot-branch2-confirm-yes-staging.onrender.com/yemot-media', t),
    'api_link=https://ext2.88-214-55-82.sslip.io/yemot-media');
});
test('correct links are left alone', () => {
  assert.equal(rewriteIni('api_link=https://main.88-214-55-82.sslip.io/yemot', t), null);
});
test('guard fixes only the wrong extension', async () => {
  process.env.PUBLIC_BASE_URL = 'https://main.88-214-55-82.sslip.io';
  process.env.YEMOT_TOKEN = 'x:y';
  const uploads = [];
  const fetchImpl = async (url, opts) => {
    if (String(url).includes('GetTextFile')) {
      const what = new URL(url).searchParams.get('what');
      return { json: async () => ({ responseStatus: 'OK', contents: what === 'ivr2:/3/ext.ini' ? 'api_link=https://yemot-gemini-server.onrender.com/yemot-backup' : 'type=menu' }) };
    }
    uploads.push(Object.fromEntries(opts.body));
    return { json: async () => ({ responseStatus: 'OK' }) };
  };
  const r = await guardOnce({ log: { warn() {} }, fetchImpl });
  assert.deepEqual(r.fixed, ['3']);
  assert.equal(uploads[0].contents, 'api_link=https://main.88-214-55-82.sslip.io/yemot-backup');
});
