/**
 * Isolated YouTube IVR helpers.
 *
 * This module deliberately handles discovery and keypad selection only.
 * YouTube Data API search results are metadata, not playable audio streams.
 * Playback must be connected separately to a permitted audio source and a
 * playback method supported by the telephony provider.
 */

export function normalizeYouTubeQuery(value) {
  return String(value || '')
    .replace(/(תחפש לי באינטרנט|תחפש באינטרנט|חפש באינטרנט|ביוטיוב|ביויוטב|ביוטוב|ב youtube|youtube)/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 120);
}

export async function searchYouTubeVideos(query, {
  apiKey = process.env.YOUTUBE_API_KEY,
  regionCode = process.env.YOUTUBE_REGION_CODE || 'IL',
  fetchImpl = fetch,
  timeoutMs = 15000
} = {}) {
  const key = String(apiKey || '').trim();
  const q = normalizeYouTubeQuery(query);
  if (!key) throw Object.assign(new Error('YouTube search is not configured'), { status: 503 });
  if (!q) return [];

  const url = new URL('https://www.googleapis.com/youtube/v3/search');
  url.searchParams.set('part', 'snippet');
  url.searchParams.set('q', q);
  url.searchParams.set('type', 'video');
  url.searchParams.set('maxResults', '10');
  url.searchParams.set('safeSearch', 'strict');
  url.searchParams.set('regionCode', regionCode);
  url.searchParams.set('order', /(הכי חדש|החדש ביותר|אחרון|אחרונה|עדכני ביותר|חדש ביותר)/i.test(query) ? 'date' : 'relevance');
  url.searchParams.set('key', key);

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
    return (data.items || []).filter(item => item.id?.videoId).map(item => ({
      videoId: item.id.videoId,
      title: String(item.snippet?.title || 'ללא כותרת'),
      channelTitle: String(item.snippet?.channelTitle || 'ערוץ לא ידוע'),
      publishedAt: item.snippet?.publishedAt || null,
      description: String(item.snippet?.description || '')
    }));
  } finally {
    clearTimeout(timer);
  }
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
