import test from 'node:test';
import assert from 'node:assert/strict';
import { telegramParts, parsePost, telegramResolve } from './telegram-media.js';
import { inspectLink } from './web-media.js';

const POST = `<div class="tgme_widget_message_wrap"><div data-post="kolchai/812"><a class="tgme_widget_message_owner_name"><span>קול חי</span></a>
<i class="tgme_widget_message_video_thumb" style="background-image:url('https://cdn4.telesco.pe/file/t.jpg')"></i>
<video src="https://cdn4.telesco.pe/file/v.mp4?token=a&amp;b=1" class="tgme_widget_message_video"></video><time class="message_video_duration">3:05</time>
<div class="tgme_widget_message_text">ניגון חדש<br/>לשבת</div><time datetime="2026-11-20T10:00:00+00:00"></time></div></div>`;

test('telegram links are recognised (post and channel)', () => {
  assert.deepEqual(telegramParts('https://t.me/kolchai/812'), { channel: 'kolchai', post: '812' });
  assert.deepEqual(telegramParts('https://t.me/s/kolchai'), { channel: 'kolchai', post: null });
  assert.equal(telegramParts('https://example.com/a'), null);
});
test('a public post gives its file, title, picture and length', () => {
  const p = parsePost(POST);
  assert.equal(p.media, 'https://cdn4.telesco.pe/file/v.mp4?token=a&b=1');
  assert.equal(p.title, 'ניגון חדש לשבת'); assert.equal(p.durationSec, 185); assert.equal(p.uploader, 'קול חי'); assert.ok(p.hasVideo);
});
test('a channel link gives its newest post with a file, as a downloadable item', async () => {
  const fetchImpl = async u => ({ ok: true, text: async () => (/\/s\//.test(u) ? POST : '') });
  const r = await telegramResolve('https://t.me/kolchai', { fetchImpl });
  assert.equal(r.page, 'https://t.me/kolchai/812');
  const it = await inspectLink({ url: 'https://t.me/kolchai', title: 'x' }, { telegram: u => telegramResolve(u, { fetchImpl }), followRedirect: async u => u });
  assert.equal(it.site, 't.me'); assert.equal(it.page, 'https://t.me/kolchai/812'); assert.ok(it.id);
});
