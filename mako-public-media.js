// Resolve only the site's public playback flow. No account credentials,
// payment bypass, external service or decryption keys are used.
const BASE = 'https://www.mako.co.il';
const TICKETS = 'https://mass.mako.co.il/ClicksStatistics/entitlementsServicesV2.jsp';
export const MAKO_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36';
export function isMakoEpisode(url) {
  try { const u = new URL(url); return u.protocol === 'https:' && /^(?:www\.)?mako\.co\.il$/i.test(u.hostname) && /\/VOD-[\w-]+\.htm$/i.test(u.pathname) && !u.username && !u.password; } catch { return false; }
}
function mediaUrl(value) {
  if (typeof value !== 'string' || !value.trim()) return null;
  try {
    const u = new URL(value, BASE);
    if (u.protocol !== 'https:' || u.username || u.password) return null;
    if (!/(?:^|\.)(?:akamaized\.net|akamaihd\.net|cloudfront\.net|mako\.co\.il)$/i.test(u.hostname)) return null;
    return u;
  } catch { return null; }
}

export async function resolveMakoPublic(url, { fetchImpl = fetch, timeoutMs = 15000 } = {}) {
  if (!isMakoEpisode(url)) return null;
  const until = Date.now() + timeoutMs;
  const headers = { 'User-Agent': MAKO_UA, Referer: BASE + '/', Origin: BASE, Accept: 'application/json, text/plain, */*' };
  const read = async endpoint => {
    const left = until - Date.now();
    if (left <= 0) throw Error('timeout');
    const r = await fetchImpl(endpoint, { headers, redirect: 'error', signal: AbortSignal.timeout(Math.max(1, left)) });
    if (!r.ok) throw Error('HTTP ' + r.status);
    return r.json();
  };
  try {
    const page = new URL(url); page.searchParams.set('platform', 'mobileApp');
    const raw = await read(page.href), data = raw?.root || raw;
    const vod = data?.vod;
    if (!vod?.itemVcmId || !vod?.channelId) return null;
    const playlist = new URL('/AjaxPage', BASE);
    for (const [k, v] of Object.entries({ jspName: 'playlist.jsp', vcmid: vod.itemVcmId, videoChannelId: vod.channelId, galleryChannelId: vod.itemVcmId, isGallery: 'false', consumer: 'web_html5', encryption: 'no' })) playlist.searchParams.set(k, String(v));
    const response = await read(playlist.href);
    const mediaUrls = [];
    let denied = false;
    for (const cdn of ['AWS', 'AKAMAI']) {
      const entries = (Array.isArray(response?.media) ? response.media : []).filter(x => x?.cdn === cdn).sort((a, b) => (Number(b.cdnLB) || 0) - (Number(a.cdnLB) || 0));
      const media = mediaUrl(entries[0]?.url);
      if (!media) continue;
      // The Akamai source is signed afresh by the entitlement response.
      if (cdn === 'AKAMAI') media.search = '';
      const ticketUrl = new URL(TICKETS);
      ticketUrl.searchParams.set('et', 'gt'); ticketUrl.searchParams.set('lp', media.href); ticketUrl.searchParams.set('rv', cdn);
      let result;
      try { result = await read(ticketUrl.href); } catch { continue; }
      if (String(result?.caseId) !== '1') { denied = true; continue; }
      const encoded = result?.tickets?.[0]?.ticket;
      if (typeof encoded !== 'string' || encoded.length > 16000) continue;
      let ticket;
      try { ticket = decodeURIComponent(encoded.replace(/\+/g, ' ')); } catch { continue; }
      if (!ticket || /[\r\n#]/.test(ticket)) continue;
      mediaUrls.push(media.href + (media.search ? '&' : '?') + ticket);
    }
    return { media: mediaUrls[0] || null, mediaUrls, title: data?.seo?.title || null, image: data?.seo?.image || null,
      httpHeaders: { 'User-Agent': MAKO_UA, Referer: BASE + '/', Origin: BASE },
      reason: mediaUrls.length ? null : denied ? 'access_denied' : 'unsupported' };
  } catch (e) { return { media: null, mediaUrls: [], reason: /403|401/.test(e.message) ? 'access_denied' : /timeout|abort/i.test(e.message) ? 'timeout' : 'unsupported' }; }
}

// Search results may wait in a phone menu. Renew the public ticket immediately
// before downloading, retaining the original item id and descriptive metadata.
export async function refreshMakoItem(item, opts = {}) {
  if (!isMakoEpisode(item?.page)) return item;
  const r = await resolveMakoPublic(item.page, opts);
  if (!r?.media) throw Object.assign(new Error('Public playback authorization unavailable'), { code: 'web_access_unavailable' });
  return { ...item, url: r.media, alternateUrls: r.mediaUrls.slice(1), referer: r.httpHeaders.Referer, httpHeaders: r.httpHeaders };
}
