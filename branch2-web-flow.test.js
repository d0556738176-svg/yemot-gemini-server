import test from 'node:test';
import assert from 'node:assert/strict';
import { siteName, lengthText, youtubeIdOf, mergeResults, resultsPageText } from './branch2-web-flow.js';
import { webIdFor, registerWebItem, webItem, webFacts, isWebId } from './web-items.js';
import { searchWebMedia } from './web-media.js';
import { argsFor } from './youtube-direct.js';
import { downloadMetadata } from './youtube-cover-art.js';
import { fetchVideoFacts } from './youtube-video-facts.js';
import { historyPath } from './branch2-search-history.js';

test('web ids are 11 characters and pass the YouTube id check', () => {
  const id = webIdFor('https://www.hidabroot.org/video/12345');
  assert.match(id, /^w[A-Za-z0-9]{10}$/);
  assert.match(id, /^[A-Za-z0-9_-]{11}$/);
  assert.equal(id, webIdFor('https://www.hidabroot.org/video/12345'));
});

test('a registered web item gives its link, facts and metadata', async () => {
  const id = registerWebItem({ url: 'https://soundcloud.com/a/b', title: 'שיר', site: 'soundcloud.com', uploader: 'זמר', durationSec: 200, uploadDate: '20250102', hasAudio: true, hasVideo: false, thumbnail: 'https://x/y.jpg' });
  assert.ok(isWebId(id));
  const w = await webItem(id);
  assert.equal(w.url, 'https://soundcloud.com/a/b');
  const f = await fetchVideoFacts(id, {});
  assert.equal(f.title, 'שיר'); assert.equal(f.durationSeconds, 200); assert.equal(f.publishedAt, '2025-01-02T00:00:00Z');
  const m = downloadMetadata(id, f);
  assert.equal(m.website, 'https://soundcloud.com/a/b');
  assert.equal(m.publisher, 'soundcloud.com');
  assert.equal(webFacts(null), null);
});

test('the downloader is given the site link instead of a YouTube id', () => {
  const a = argsFor('wABCDEFGHIJ', '/tmp/x.m4a', { target: 'https://site/x', impersonate: true });
  assert.equal(a.at(-1), 'https://site/x');
  assert.ok(a.includes('--impersonate'));
  const y = argsFor('dQw4w9WgXcQ', '/tmp/x.m4a', {});
  assert.equal(y.at(-1), 'dQw4w9WgXcQ');
  assert.ok(!y.includes('--impersonate'));
});

test('site names, lengths and YouTube links', () => {
  assert.equal(siteName('www.hidabroot.org'), 'הידברות');
  assert.equal(siteName('media.soundcloud.com'), 'סאונדקלאוד');
  assert.equal(siteName('example.co.il'), 'example');
  assert.equal(lengthText(3700), 'אורך שעה ו 2 דקות');
  assert.equal(lengthText(125), 'אורך 2 דקות');
  assert.equal(lengthText(0), '');
  assert.equal(youtubeIdOf('https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=1'), 'dQw4w9WgXcQ');
  assert.equal(youtubeIdOf('https://youtu.be/dQw4w9WgXcQ'), 'dQw4w9WgXcQ');
});

test('results: other sites first, then YouTube once each, read as a numbered list', () => {
  const r = mergeResults({ items: [{ id: 'wAAAAAAAAAA', title: 'שיעור', site: 'hidabroot.org', durationSec: 600, hasVideo: false }],
    youtube: [{ url: 'https://youtu.be/dQw4w9WgXcQ', title: 'סרטון - YouTube' }, { url: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ', title: 'שוב' }] });
  assert.equal(r.length, 2);
  assert.equal(r[1].title, 'סרטון');
  const t = resultsPageText(r, 0, 20);
  assert.match(t, /^1, שיעור, מאתר הידברות, אורך 10 דקות, שמע בלבד\. 2, סרטון, מאתר יוטיוב\.$/);
});

test('the whole-web search keeps only links that really hold media', async () => {
  const progress = [];
  const r = await searchWebMedia('x', {
    candidates: [{ url: 'https://a.com/1' }, { url: 'https://youtu.be/dQw4w9WgXcQ' }, { url: 'https://b.com/2' }],
    inspect: async c => c.url.includes('a.com') ? { id: 'wBBBBBBBBBB', title: 'a' } : null,
    onProgress: p => progress.push(p),
  });
  assert.equal(r.items.length, 1);
  assert.equal(r.youtube.length, 1);
  assert.equal(r.checked, 3);
  assert.ok(progress.length >= 1);
});

test('the web searches have their own history list', () => {
  assert.equal(historyPath('0501234567'), 'ivr2:/2/youtubejobs/history/0501234567.json');
  assert.equal(historyPath('0501234567', 'web'), 'ivr2:/2/youtubejobs/history/web-0501234567.json');
});
