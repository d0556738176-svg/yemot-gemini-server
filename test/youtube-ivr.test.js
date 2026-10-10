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
