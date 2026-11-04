import test from 'node:test';
import assert from 'node:assert/strict';
import {
  normalizeYouTubeQuery,
  formatYouTubeChoices,
  getSelectedYouTubeVideo,
  searchYouTubeVideos
} from '../youtube-ivr.js';

function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json' }
  });
}

test('normalizes Hebrew YouTube voice-search wording', () => {
  assert.equal(
    normalizeYouTubeQuery('חפש באינטרנט ביוטיוב   אילן גוזל'),
    'אילן גוזל'
  );
});

test('newest-video search removes Hebrew filler and ranks the right channel', async () => {
  const requested = [];
  const fetchImpl = async input => {
    const url = new URL(input);
    requested.push(url);
    if (url.pathname.endsWith('/search') && url.searchParams.get('type') === 'channel') {
      assert.equal(url.searchParams.get('q'), 'אילן גוזל');
      return jsonResponse({
        items: [
          { id: { channelId: 'other' }, snippet: { title: 'אילן חדשות' } },
          { id: { channelId: 'target' }, snippet: { title: 'אילן גוזל הרשמי' } }
        ]
      });
    }
    if (url.pathname.endsWith('/channels')) {
      assert.equal(url.searchParams.get('id'), 'target');
      return jsonResponse({
        items: [{
          snippet: { title: 'אילן גוזל הרשמי' },
          contentDetails: { relatedPlaylists: { uploads: 'uploads-target' } }
        }]
      });
    }
    if (url.pathname.endsWith('/playlistItems')) {
      return jsonResponse({
        items: [{
          contentDetails: {
            videoId: 'video123',
            videoPublishedAt: '2026-10-09T00:00:00Z'
          },
          snippet: {
            title: 'הסרטון החדש',
            channelTitle: 'אילן גוזל הרשמי',
            description: 'תיאור'
          }
        }]
      });
    }
    throw new Error('Unexpected YouTube API endpoint: ' + url.pathname);
  };

  const videos = await searchYouTubeVideos(
    'תביא לי את הסרטון הכי חדש של אילן גוזל ביוטיוב',
    { apiKey: 'test-key', fetchImpl }
  );

  assert.equal(videos.length, 1);
  assert.equal(videos[0].videoId, 'video123');
  assert.equal(videos[0].channelTitle, 'אילן גוזל הרשמי');
  assert.equal(requested.length, 3);
});

test('formats numbered choices and returns the selected video safely', () => {
  const videos = [
    { videoId: 'video123', title: 'שיר ראשון', channelTitle: 'ערוץ א' },
    { videoId: 'video456', title: 'שיר שני', channelTitle: 'ערוץ ב' }
  ];
  const spoken = formatYouTubeChoices(videos);

  assert.match(spoken, /תוצאה מספר 1/);
  assert.match(spoken, /הקש את מספר התוצאה הרצויה/);
  assert.equal(getSelectedYouTubeVideo(videos, '2').videoId, 'video456');
  assert.equal(getSelectedYouTubeVideo(videos, '0'), null);
  assert.equal(getSelectedYouTubeVideo(videos, '3'), null);
  assert.equal(getSelectedYouTubeVideo(videos, 'abc'), null);
});

test('newest search falls back to date-sorted search when the uploads list answers 404', async () => {
  const calls = [];
  const fetchImpl = async url => {
    const u = new URL(url); calls.push(u.pathname + '?type=' + (u.searchParams.get('type') || '') + '&order=' + (u.searchParams.get('order') || ''));
    if (u.pathname.endsWith('/search') && u.searchParams.get('type') === 'channel')
      return Response.json({ items: [{ id: { channelId: 'UC1' }, snippet: { title: 'בר צברי' } }] });
    if (u.pathname.endsWith('/channels')) return Response.json({ items: [{ contentDetails: { relatedPlaylists: { uploads: 'UU1' } }, snippet: { title: 'בר צברי' } }] });
    if (u.pathname.endsWith('/playlistItems')) return Response.json({ error: { code: 404, message: 'playlistNotFound' } }, { status: 404 });
    if (u.pathname.endsWith('/search')) return Response.json({ items: [{ id: { videoId: 'abcdefghijk' }, snippet: { title: 'שיר חדש', channelTitle: 'בר צברי', publishedAt: '2026-11-01T00:00:00Z' } }] });
    throw Error('unexpected ' + url);
  };
  const videos = await searchYouTubeVideos('בר צברי הסרטון הכי חדש', { apiKey: 'k', fetchImpl });
  assert.equal(videos.length, 1);
  assert.equal(videos[0].videoId, 'abcdefghijk');
  assert.ok(calls.some(c => c.includes('type=video&order=date')), 'fell back to the date-sorted video search');
});

test('newest search ignores a channel whose name does not match the request', async () => {
  let usedChannel = false;
  const fetchImpl = async url => {
    const u = new URL(url);
    if (u.pathname.endsWith('/search') && u.searchParams.get('type') === 'channel')
      return Response.json({ items: [{ id: { channelId: 'UCx' }, snippet: { title: 'ערוץ אחר לגמרי' } }] });
    if (u.pathname.endsWith('/channels') || u.pathname.endsWith('/playlistItems')) { usedChannel = true; return Response.json({ items: [] }); }
    return Response.json({ items: [{ id: { videoId: 'zzzzzzzzzzz' }, snippet: { title: 'x', channelTitle: 'y' } }] });
  };
  const videos = await searchYouTubeVideos('קופה ראשית הכי חדש', { apiKey: 'k', fetchImpl });
  assert.equal(usedChannel, false);
  assert.equal(videos[0].videoId, 'zzzzzzzzzzz');
});
