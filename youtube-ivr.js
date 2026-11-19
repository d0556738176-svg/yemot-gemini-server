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
    // JavaScript's \b word boundary does not treat Hebrew letters as word characters.
    // Unicode letter/number boundaries make Hebrew filler words removable without
    // matching the same text inside a longer Hebrew word.
    .replace(/(^|[^\p{L}\p{N}])(החדש ביותר|עדכני ביותר|הכי חדשה|הכי חדש|חדש ביותר|האחרונה|האחרון|אחרונה|אחרון|החדשה|החדש|חדשה|חדש)(?=$|[^\p{L}\p{N}])/giu, '$1 ')
    .replace(/(^|[^\p{L}\p{N}])(אני רוצה לראות|תביא לי|תמצא לי|תראה לי|את הסרטון|הסרטונים|הסרטון|סרטונים|סרטון|אני רוצה|תביא|תן לי|תמצא|בנושא|נושא)(?=$|[^\p{L}\p{N}])/giu, '$1 ')
    .replace(/^\s*של\s+/i, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 120);
}

// "הסרטון הכי חדש של X", "סרטון חדש של הערוץ X", "הפרק החדש של X המלא"
// (owner, 13.11: "חדש" alone counts too).
export function wantsNewestQuery(original) {
  return /(^|[^\p{L}\p{N}])(הכי חדש|הכי חדשה|החדש ביותר|חדש ביותר|עדכני ביותר|החדש|החדשה|חדש|חדשה|האחרון|האחרונה|אחרון|אחרונה|העדכני|האחרונים|החדשים)(?=$|[^\p{L}\p{N}])/iu.test(String(original || ''));
}

// The channel or show name alone, for finding its channel: without
// "הערוץ", "פרק", "המלא" and the like (they are never part of a name).
export function channelNameFrom(q) {
  return String(q || '')
    // "ערוץ 14", "ערוץ 13": with a number the word is part of the name (18.11).
    .replace(/(^|[^\p{L}\p{N}])(של הערוץ|הערוץ של|הערוץ(?!\s*\d)|ערוץ(?!\s*\d)|בערוץ(?!\s*\d)|של התוכנית|התוכנית|תוכנית|הפרק המלא|פרק מלא|הפרק|פרק|פרקים|המלא|המלאה|מלא|מלאה|עונה|חדש|חדשה|של)(?=$|[^\p{L}\p{N}])/giu, '$1 ')
    .replace(/\s+/g, ' ').trim();
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
      error.httpStatus = response.status;
      error.reason = String(data?.error?.errors?.[0]?.reason || data?.error?.status || '');
      throw error;
    }
    return data;
  } finally {
    clearTimeout(timer);
  }
}

// Every YouTube key the owner configured: YOUTUBE_API_KEY, YOUTUBE_BACKUP_API_KEY
// and extra fields YOUTUBE_API_KEY_2 ... YOUTUBE_API_KEY_9. One key allows
// about 100 searches a day (each search costs 100 of its 10,000 daily units).
export function youtubeKeysFrom(env = process.env, first = '') {
  return [...new Set([first, env.YOUTUBE_API_KEY, env.YOUTUBE_BACKUP_API_KEY,
    ...[2, 3, 4, 5, 6, 7, 8, 9].map(n => env['YOUTUBE_API_KEY_' + n])]
    .map(k => String(k || '').trim()).filter(Boolean))];
}
const exhaustedYouTubeKeys = new Map();

/**
 * Searches with the first key whose daily quota is not used up; a key that
 * answers 403 (quota / not allowed) or 429 rests for an hour and the next key
 * is tried, so search keeps working when one key's quota runs out.
 */
export async function searchYouTubeVideos(query, options = {}) {
  try {
    return await withYouTubeKey(apiKey => searchYouTubeVideosWithKey(query, { ...options, apiKey }), options);
  } catch (error) {
    // Owner, 19.11: search must stay free with no daily limit. When every
    // Google key is out of its daily quota (403/429) or none is set, the
    // server's own yt-dlp searches YouTube directly (no key, no quota).
    const quota = [403, 429].includes(error?.httpStatus) || error?.status === 503;
    if (!quota || options.pageToken || process.env.YTDLP_SEARCH === 'off') throw error;
    const found = await ytdlpSearchVideos(query, options).catch(() => []);
    if (!found.length) throw error;
    console.warn('[YouTube IVR] Google quota used up; searched with the server\'s yt-dlp', { results: found.length });
    return found;
  }
}

// YouTube search through the server's yt-dlp: same shape as the API results.
export async function ytdlpSearchVideos(query, { newest = null, count = 40, timeoutMs = 20000, execImpl = null } = {}) {
  const original = String(query || '').trim();
  const q = cleanedSearchText(original);
  if (!q) return [];
  const wantsNewest = newest == null ? wantsNewestQuery(original) : !!newest;
  const args = ['--flat-playlist', '-J', '--no-warnings', '--ignore-errors', (wantsNewest ? 'ytsearchdate' : 'ytsearch') + count + ':' + q];
  const bin = process.env.YTDLP_BIN || '/usr/local/bin/yt-dlp';
  const stdout = await (execImpl ? execImpl(bin, args) : new Promise(async (resolve, reject) => {
    const { execFile } = await import('node:child_process');
    execFile(bin, args, { timeout: timeoutMs, maxBuffer: 30 * 1024 * 1024 }, (err, out) => (out ? resolve(out) : reject(err || new Error('no output'))));
  }));
  const entries = JSON.parse(stdout).entries || [];
  const results = entries.filter(e => /^[A-Za-z0-9_-]{11}$/.test(String(e?.id || '')) && e.live_status !== 'is_live').map(e => {
    const ud = String(e.upload_date || '');
    return {
      videoId: String(e.id),
      title: String(e.title || 'ללא כותרת'),
      channelTitle: String(e.channel || e.uploader || 'ערוץ לא ידוע'),
      publishedAt: /^\d{8}$/.test(ud) ? ud.slice(0, 4) + '-' + ud.slice(4, 6) + '-' + ud.slice(6, 8) + 'T00:00:00Z' : (e.timestamp ? new Date(e.timestamp * 1000).toISOString() : null),
      description: String(e.description || '')
    };
  });
  Object.defineProperty(results, 'nextPageToken', { value: null, enumerable: false });
  return results;
}

// The next page of a channel's uploads (newest first), with the same key rotation.
export async function moreChannelUploads(playlistId, pageToken, options = {}) {
  return withYouTubeKey(key => channelUploadsPage(playlistId, pageToken, { ...options, key }), options);
}

async function withYouTubeKey(run, options = {}) {
  const keys = youtubeKeysFrom(process.env, options.apiKey);
  if (!keys.length) return run(options.apiKey);
  const now = Date.now();
  const usable = keys.filter(k => !(exhaustedYouTubeKeys.get(k) > now));
  const order = usable.length ? usable : keys;
  let lastError = null;
  for (let i = 0; i < order.length; i++) {
    try {
      return await run(order[i]);
    } catch (error) {
      lastError = error;
      if (![403, 429].includes(error?.httpStatus)) throw error;
      exhaustedYouTubeKeys.set(order[i], now + 60 * 60 * 1000);
      console.warn('[YouTube IVR] search key unavailable; trying next key', { key: keys.indexOf(order[i]) + 1, of: keys.length, status: error.httpStatus, reason: error.reason });
    }
  }
  throw lastError;
}

async function searchYouTubeVideosWithKey(query, {
  apiKey = process.env.YOUTUBE_API_KEY,
  regionCode = process.env.YOUTUBE_REGION_CODE || 'IL',
  fetchImpl = fetch,
  timeoutMs = 15000,
  pageToken = null,
  relevanceLanguage = null,
  newest = null
} = {}) {
  const key = String(apiKey || '').trim();
  const original = String(query || '').trim();
  const q = cleanedSearchText(original);

  if (!key) throw Object.assign(new Error('YouTube search is not configured'), { status: 503 });
  if (!q) return [];

  const wantsNewest = newest == null ? wantsNewestQuery(original) : !!newest;

  // For "הסרטון הכי חדש של X", resolve the channel and then read its
  // dedicated uploads playlist. This is more precise than a generic video
  // search because YouTube exposes the uploads playlist on the channel.
  if (wantsNewest && !pageToken) {
    // Optional precision step. Any failure here (YouTube answers 404 for some
    // channels' uploads list, live 03.11) or no channel whose name matches
    // the request falls back to the normal search sorted by date below —
    // a "newest" request must never fail the whole search.
    try {
      const channelVideos = await newestFromMatchingChannel(channelNameFrom(q) || q, { key, regionCode, fetchImpl, timeoutMs, wantsFull: /(^|[^\p{L}])(המלא|המלאה|מלא|מלאה)(?=$|[^\p{L}])/u.test(original) });
      if (channelVideos.length) return channelVideos;
    } catch (error) {
      // A used-up key must move to the next key, not be retried here.
      if ([403, 429].includes(error?.httpStatus)) throw error;
      console.warn('[YouTube IVR] newest-video channel lookup failed; using date-sorted search', { status: error?.status || null, message: String(error?.message || error).slice(0, 120) });
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
  if (pageToken) url.searchParams.set('pageToken', pageToken);
  if (relevanceLanguage) url.searchParams.set('relevanceLanguage', relevanceLanguage);

  const data = await fetchJson(url, fetchImpl, timeoutMs);
  let results = (data.items || [])
    .filter(item => item.id?.videoId)
    .map(item => ({
      videoId: item.id.videoId,
      title: String(item.snippet?.title || 'ללא כותרת'),
      channelTitle: String(item.snippet?.channelTitle || 'ערוץ לא ידוע'),
      publishedAt: item.snippet?.publishedAt || null,
      description: String(item.snippet?.description || '')
    }));

  if (wantsNewest) {
    // Prefer results whose channel title actually contains the requested
    // person's/channel words. This is a fallback only; uploads-playlist
    // resolution above remains the authoritative path.
    const words = q.toLowerCase().split(/\s+/).filter(w => w.length > 1);
    results.sort((a, b) => {
      const ac = String(a.channelTitle||'').toLowerCase();
      const bc = String(b.channelTitle||'').toLowerCase();
      const as = words.reduce((n,w)=>n+(ac.includes(w)?1:0),0);
      const bs = words.reduce((n,w)=>n+(bc.includes(w)?1:0),0);
      return bs-as || Date.parse(b.publishedAt || 0) - Date.parse(a.publishedAt || 0);
    });
  }

  // The next 50 results are one more request away ("עוד" after the last one).
  Object.defineProperty(results, 'nextPageToken', { value: data.nextPageToken || null, enumerable: false });
  return results;
}

// A show on a broadcaster's channel (many shows): the newest videos whose
// title has the show's name come first; "המלא" -> titles that say full
// episode first; then the channel's other uploads, newest first.
export function orderChannelUploads(videos, name, channelIsTheName, wantsFull) {
  const words = String(name || '').toLowerCase().split(/\s+/).filter(w => w.length > 1);
  const has = v => words.length && words.every(w => String(v.title || '').toLowerCase().includes(w));
  const full = v => /פרק מלא|הפרק המלא|full episode|(^|[^\p{L}])מלא(?=$|[^\p{L}])/iu.test(String(v.title || ''));
  const byDate = (a, b) => Date.parse(b.publishedAt || 0) - Date.parse(a.publishedAt || 0);
  const list = [...videos].sort(byDate);
  const named = channelIsTheName ? list : list.filter(has);
  const rest = list.filter(v => !named.includes(v));
  const pick = arr => (wantsFull ? [...arr.filter(full), ...arr.filter(v => !full(v))] : arr);
  return [...pick(named), ...pick(rest)];
}

async function newestFromMatchingChannel(q, { key, regionCode, fetchImpl, timeoutMs, wantsFull = false }) {
  const channelUrl = new URL('https://www.googleapis.com/youtube/v3/search');
  channelUrl.searchParams.set('part', 'snippet');
  channelUrl.searchParams.set('q', q);
  channelUrl.searchParams.set('type', 'channel');
  channelUrl.searchParams.set('maxResults', '10');
  channelUrl.searchParams.set('regionCode', regionCode);
  channelUrl.searchParams.set('key', key);
  const channelData = await fetchJson(channelUrl, fetchImpl, timeoutMs);
  const channels = (channelData.items || []).filter(x => x.id?.channelId);
  if (!channels.length) return [];
  const words = q.toLowerCase().split(/\s+/).filter(Boolean);
  const ranked = channels.map((channel, index) => {
    const title = String(channel.snippet?.title || channel.snippet?.channelTitle || '').toLowerCase();
    const score = words.reduce((sum, word) => sum + (title.includes(word) ? 1 : 0), 0);
    return { channel, score, index };
  }).sort((a, b) => b.score - a.score || a.index - b.index);
  // Only a channel whose name really matches the request; otherwise the
  // date-sorted search is more accurate than an unrelated channel.
  if (!(ranked[0].score > 0)) return [];
  const channelId = ranked[0].channel.id.channelId;
  const channelDetailsUrl = new URL('https://www.googleapis.com/youtube/v3/channels');
  channelDetailsUrl.searchParams.set('part', 'contentDetails,snippet');
  channelDetailsUrl.searchParams.set('id', channelId);
  channelDetailsUrl.searchParams.set('key', key);
  const channelDetails = await fetchJson(channelDetailsUrl, fetchImpl, timeoutMs);
  const uploadsPlaylistId = channelDetails.items?.[0]?.contentDetails?.relatedPlaylists?.uploads;
  if (!uploadsPlaylistId) return [];
  const page = await channelUploadsPage(uploadsPlaylistId, null, { key, fetchImpl, timeoutMs, channelTitle: channelDetails.items?.[0]?.snippet?.title });
  const ordered = orderChannelUploads(page, q, ranked[0].score === words.length, wantsFull);
  // 18.11: the whole channel, newest first, page after page ("0" = 20 more).
  Object.defineProperty(ordered, 'uploads', { value: { playlistId: uploadsPlaylistId, token: page.nextPageToken || null, channelTitle: channelDetails.items?.[0]?.snippet?.title || '' }, enumerable: false });
  return ordered;
}

// One page (50) of a channel's uploads list, newest first.
export async function channelUploadsPage(playlistId, pageToken, { key = youtubeKeysFrom(process.env)[0], fetchImpl = fetch, timeoutMs = 15000, channelTitle = '' } = {}) {
  const uploadsUrl = new URL('https://www.googleapis.com/youtube/v3/playlistItems');
  uploadsUrl.searchParams.set('part', 'snippet,contentDetails');
  uploadsUrl.searchParams.set('playlistId', playlistId);
  uploadsUrl.searchParams.set('maxResults', '50');
  uploadsUrl.searchParams.set('key', key);
  if (pageToken) uploadsUrl.searchParams.set('pageToken', pageToken);
  const uploadsData = await fetchJson(uploadsUrl, fetchImpl, timeoutMs);
  const videos = (uploadsData.items || [])
    .filter(item => item.contentDetails?.videoId)
    .filter(item => !/^(Private|Deleted) video$/.test(String(item.snippet?.title || '')))
    .map(item => ({
      videoId: item.contentDetails.videoId,
      title: String(item.snippet?.title || 'ללא כותרת'),
      channelTitle: String(item.snippet?.videoOwnerChannelTitle || item.snippet?.channelTitle || channelTitle || 'ערוץ לא ידוע'),
      publishedAt: item.contentDetails?.videoPublishedAt || item.snippet?.publishedAt || null,
      description: String(item.snippet?.description || '')
    }))
    .sort((a, b) => Date.parse(b.publishedAt || 0) - Date.parse(a.publishedAt || 0));
  Object.defineProperty(videos, 'nextPageToken', { value: uploadsData.nextPageToken || null, enumerable: false });
  return videos;
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
