/**
 * Isolated YouTube IVR helpers.
 * Search and keypad selection are kept independent from playback.
 */

export function normalizeYouTubeQuery(value) {
  return String(value || '')
    .replace(/(תחפש לי באינטרנט|תחפש באינטרנט|חפש באינטרנט|ביוטיוב|ביויוטב|ביוטוב|ב youtube|youtube)/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 120);
}

function cleanedSearchText(original) {
  return normalizeYouTubeQuery(original)
    .replace(/\b(הכי חדש|החדש ביותר|הכי חדשה|החדש|האחרון|האחרונה|אחרון|אחרונה|עדכני ביותר|חדש ביותר)\b/gi, ' ')
    .replace(/\b(תביא לי|תביא|תן לי|תמצא לי|תמצא|תראה לי|אני רוצה|אני רוצה לראות|את הסרטון|סרטון|סרטונים|בנושא|נושא)\b/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 120);
}

function wantsNewestQuery(original) {
  return /(הכי חדש|החדש ביותר|הכי חדשה|החדש|האחרון|האחרונה|אחרון|אחרונה|עדכני ביותר|חדש ביותר)/i.test(String(original || ''));
}

async function fetchJson(url, fetchImpl, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(url, { signal: controller.signal });
    const data = await response.json();
    if (!response.ok) {
      const error = new Error('YouTube search failed with HTTP ' + response.status);
      error.status = response.status === 403 ? 502 : response.status;
      throw error;
    }
    return data;
  } finally {
    clearTimeout(timer);
  }
}

export async function searchYouTubeVideos(query, {
  apiKey = process.env.YOUTUBE_API_KEY,
  regionCode = process.env.YOUTUBE_REGION_CODE || 'IL',
  fetchImpl = fetch,
  timeoutMs = 15000
} = {}) {
  const key = String(apiKey || '').trim();
  const original = String(query || '').trim();
  const q = cleanedSearchText(original);

  if (!key) throw Object.assign(new Error('YouTube search is not configured'), { status: 503 });
  if (!q) return [];

  const wantsNewest = wantsNewestQuery(original);

  // For "הסרטון הכי חדש של X", resolve the channel and then read its
  // dedicated uploads playlist. This is more precise than a generic video
  // search because YouTube exposes the uploads playlist on the channel.
  if (wantsNewest) {
    const channelUrl = new URL('https://www.googleapis.com/youtube/v3/search');
    channelUrl.searchParams.set('part', 'snippet');
    channelUrl.searchParams.set('q', q);
    channelUrl.searchParams.set('type', 'channel');
    channelUrl.searchParams.set('maxResults', '10');
    channelUrl.searchParams.set('regionCode', regionCode);
    channelUrl.searchParams.set('key', key);

    const channelData = await fetchJson(channelUrl, fetchImpl, timeoutMs);
    const channels = (channelData.items || []).filter(x => x.id?.channelId);

    if (channels.length) {
      const words = q.toLowerCase().split(/\\s+/).filter(Boolean);
      const ranked = channels.map((channel, index) => {
        const title = String(channel.snippet?.channelTitle || '').toLowerCase();
        const score = words.reduce((sum, word) => sum + (title.includes(word) ? 1 : 0), 0);
        return { channel, score, index };
      }).sort((a, b) => b.score - a.score || a.index - b.index);

      const channelId = ranked[0].channel.id.channelId;

      const channelDetailsUrl = new URL('https://www.googleapis.com/youtube/v3/channels');
      channelDetailsUrl.searchParams.set('part', 'contentDetails,snippet');
      channelDetailsUrl.searchParams.set('id', channelId);
      channelDetailsUrl.searchParams.set('key', key);
      const channelDetails = await fetchJson(channelDetailsUrl, fetchImpl, timeoutMs);
      const uploadsPlaylistId = channelDetails.items?.[0]?.contentDetails?.relatedPlaylists?.uploads;

      if (uploadsPlaylistId) {
        const uploadsUrl = new URL('https://www.googleapis.com/youtube/v3/playlistItems');
        uploadsUrl.searchParams.set('part', 'snippet,contentDetails');
        uploadsUrl.searchParams.set('playlistId', uploadsPlaylistId);
        uploadsUrl.searchParams.set('maxResults', '10');
        uploadsUrl.searchParams.set('key', key);
        const uploadsData = await fetchJson(uploadsUrl, fetchImpl, timeoutMs);

        const channelVideos = (uploadsData.items || [])
          .filter(item => item.contentDetails?.videoId)
          .map(item => ({
            videoId: item.contentDetails.videoId,
            title: String(item.snippet?.title || 'ללא כותרת'),
            channelTitle: String(item.snippet?.channelTitle || channelDetails.items?.[0]?.snippet?.title || 'ערוץ לא ידוע'),
            publishedAt: item.contentDetails?.videoPublishedAt || item.snippet?.publishedAt || null,
            description: String(item.snippet?.description || '')
          }));

        if (channelVideos.length) return channelVideos;
      }
    }
  }

  const url = new URL('https://www.googleapis.com/youtube/v3/search');
  url.searchParams.set('part', 'snippet');
  url.searchParams.set('q', q);
  url.searchParams.set('type', 'video');
  url.searchParams.set('maxResults', '50');
  url.searchParams.set('safeSearch', 'none');
  url.searchParams.set('regionCode', regionCode);
  url.searchParams.set('order', wantsNewest ? 'date' : 'relevance');
  url.searchParams.set('key', key);

  const data = await fetchJson(url, fetchImpl, timeoutMs);
  const results = (data.items || [])
    .filter(item => item.id?.videoId)
    .map(item => ({
      videoId: item.id.videoId,
      title: String(item.snippet?.title || 'ללא כותרת'),
      channelTitle: String(item.snippet?.channelTitle || 'ערוץ לא ידוע'),
      publishedAt: item.snippet?.publishedAt || null,
      description: String(item.snippet?.description || '')
    }));

  if (wantsNewest) {
    results.sort((a, b) => Date.parse(b.publishedAt || 0) - Date.parse(a.publishedAt || 0));
  }

  return results;
}

export function formatYouTubeChoices(videos) {
  if (!Array.isArray(videos) || videos.length === 0) {
    return 'לא מצאתי תוצאות מתאימות. אפשר לנסות ניסוח אחר.';
  }
  return 'מצאתי את התוצאות הבאות. ' + videos.map((video, index) =>
    'לתוצאה מספר ' + (index + 1) + ': ' + cleanForSpeech(video.title) +
    '. הערוץ: ' + cleanForSpeech(video.channelTitle) + '.'
  ).join(' ') + ' הקש את מספר התוצאה הרצויה. להאזנה לתוצאות נוספות, חפש שוב עם מילות חיפוש מדויקות יותר.';
}

export function getSelectedYouTubeVideo(videos, keypadValue) {
  const digits = String(keypadValue ?? '').trim();
  if (!/^\d{1,2}$/.test(digits)) return null;
  const index = Number(digits) - 1;
  if (!Array.isArray(videos) || index < 0 || index >= videos.length) return null;
  return videos[index];
}

function cleanForSpeech(value) {
  return String(value || '').replace(/[.&"“”‘’']/g, ' ').replace(/[-–—]/g, ' ')
    .replace(/\s+/g, ' ').trim();
}
