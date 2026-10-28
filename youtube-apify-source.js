// Branch 2: get YouTube audio through an Apify actor. The actor downloads on
// Apify's infrastructure (residential proxies on their side) and stores the
// file in the run's key-value store; we fetch that file. No YouTube contact,
// no cookies, no proxy of our own.
//
// Actor is configurable (BRANCH2_APIFY_ACTOR). Input and output field names
// vary between actors, so the input is sent with several common aliases and
// the download URL is discovered defensively.
const API_BASE = 'https://api.apify.com/v2';

export function isApifyConfigured(env = process.env) {
  return !!String(env.APIFY_TOKEN || '').trim();
}

function findDownloadUrl(item) {
  if (!item || typeof item !== 'object') return null;
  const keys = ['download_url', 'fileUrl', 'downloadUrl', 'audioUrl', 'mp3Url', 'url', 'link'];
  for (const k of keys) {
    const v = item[k];
    if (typeof v === 'string' && /^https?:\/\//.test(v)) return v;
  }
  return null;
}

// Returns { url (ready to fetch), item, actorId } or throws a coded error.
export async function resolveApifyAudio(videoId, env = process.env) {
  const token = String(env.APIFY_TOKEN || '').trim();
  if (!token) throw Object.assign(new Error('APIFY_TOKEN not configured'), { code: 'not_configured' });
  if (!/^[A-Za-z0-9_-]{11}$/.test(String(videoId || ''))) throw Object.assign(new Error('invalid video id'), { code: 'invalid_video' });
  const actorId = String(env.BRANCH2_APIFY_ACTOR || 's-r/youtube-video-downloader').trim().replace('/', '~');
  const watchUrl = 'https://www.youtube.com/watch?v=' + videoId;

  // Union of input fields across common actors; unknown fields are ignored.
  const input = {
    urls: [watchUrl], videoUrls: [watchUrl], url: watchUrl, videoUrl: watchUrl,
    format: 'mp3', audioQuality: '192', quality: 'best',
    proxyMode: 'auto', maxDurationSeconds: 0
  };
  const runUrl = API_BASE + '/acts/' + actorId + '/run-sync-get-dataset-items?token=' + encodeURIComponent(token);
  const timeoutMs = Math.max(30000, Math.min(300000, Number(env.BRANCH2_APIFY_TIMEOUT_MS || 180000)));
  const response = await fetch(runUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(input),
    signal: AbortSignal.timeout(timeoutMs)
  });
  const text = await response.text();
  let items = null;
  try { items = JSON.parse(text); } catch {}
  const meta = { httpStatus: response.status, actorId, itemCount: Array.isArray(items) ? items.length : null };
  if (!response.ok) {
    throw Object.assign(new Error('Apify run HTTP ' + response.status + ': ' + text.slice(0, 160)), { code: response.status === 402 ? 'needs_payment' : 'run_http', meta });
  }
  if (!Array.isArray(items) || !items.length) throw Object.assign(new Error('Apify returned no items'), { code: 'no_items', meta });
  const item = items[0];
  meta.itemShape = Object.keys(item).slice(0, 15).join(',');
  meta.succeeded = item.succeeded ?? item.status ?? null;
  meta.error = item.error || item.error_code || null;
  if (item.succeeded === false || item.status === 'failed' || item.error) {
    throw Object.assign(new Error('Apify actor reported failure: ' + String(item.error || item.error_code || 'unknown')), { code: 'actor_failed', meta });
  }
  let url = findDownloadUrl(item);
  if (!url) throw Object.assign(new Error('Apify item has no download URL'), { code: 'no_download_url', meta });
  // Key-value-store URLs on api.apify.com need the token to download.
  if (/api\.apify\.com/.test(url) && !/[?&]token=/.test(url)) {
    url += (url.includes('?') ? '&' : '?') + 'token=' + encodeURIComponent(token);
  }
  return { url, item, actorId, meta, title: item.title || null, durationSeconds: item.durationSeconds || item.duration || null };
}
