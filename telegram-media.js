// Telegram public channels (owner, 21.11: every social network). A public
// post's own preview page (t.me/<channel>/<post>?embed=1) carries the video
// or voice file address; a channel link (t.me/<channel>) gives its newest
// post that has one (from the public t.me/s/<channel> page). Public posts
// only: nothing that needs an account.
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36';

export function telegramParts(url) {
  try {
    const u = new URL(url);
    if (!/^(?:www\.)?(?:t\.me|telegram\.me)$/i.test(u.hostname)) return null;
    const seg = u.pathname.split('/').filter(Boolean);
    if (seg[0] === 's') seg.shift();
    if (!seg[0] || !/^[A-Za-z0-9_]{4,64}$/.test(seg[0])) return null;
    return { channel: seg[0], post: /^\d+$/.test(seg[1] || '') ? seg[1] : null };
  } catch { return null; }
}

const dec = s => String(s || '').replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>');
const secs = t => { const p = String(t || '').split(':').map(Number); return p.every(Number.isFinite) && p.length > 1 ? p.reduce((a, b) => a * 60 + b, 0) : null; };

// One post's HTML (embed or a block of the channel page) -> media.
export function parsePost(html) {
  const video = html.match(/<video[^>]+src="([^"]+)"/i)?.[1] || null;
  const audio = html.match(/<audio[^>]+src="([^"]+)"/i)?.[1] || null;
  const src = dec(video || audio);
  if (!/^https:\/\//.test(src)) return null;
  const text = dec((html.match(/tgme_widget_message_text[^>]*>([\s\S]*?)<\/div>/i)?.[1] || '').replace(/<br\s*\/?>/gi, ' ').replace(/<[^>]+>/g, '')).replace(/\s+/g, ' ').trim();
  const thumb = dec(html.match(/tgme_widget_message_video_thumb[^>]*background-image:url\('([^']+)'\)/i)?.[1] || '') || null;
  const dur = secs(html.match(/(?:message_video_duration|audio_duration)[^>]*>([\d:]+)</i)?.[1]);
  const when = html.match(/<time[^>]+datetime="([^"]+)"/i)?.[1] || null;
  const author = dec(html.match(/tgme_widget_message_owner_name[^>]*>(?:<span[^>]*>)?([^<]+)/i)?.[1] || '').trim() || null;
  return { media: src, hasVideo: !!video, title: text.slice(0, 120) || null, description: text || null, thumbnail: thumb, durationSec: dur, uploadDate: when, uploader: author };
}

export async function telegramResolve(url, { fetchImpl = fetch, timeoutMs = 12000 } = {}) {
  const t = telegramParts(url);
  if (!t) return null;
  const get = async u => { const r = await fetchImpl(u, { headers: { 'User-Agent': UA, 'Accept-Language': 'he,en;q=0.8' }, signal: AbortSignal.timeout(timeoutMs) }); return r.ok ? r.text() : ''; };
  try {
    if (t.post) {
      const p = parsePost(await get('https://t.me/' + t.channel + '/' + t.post + '?embed=1&mode=tme'));
      return p ? { ...p, page: 'https://t.me/' + t.channel + '/' + t.post } : null;
    }
    const html = await get('https://t.me/s/' + t.channel);
    const blocks = html.split(/(?=<div class="tgme_widget_message_wrap)/i).reverse(); // newest first
    for (const b of blocks) {
      const p = parsePost(b);
      const id = b.match(/data-post="[^"/]+\/(\d+)"/i)?.[1];
      if (p && id) return { ...p, page: 'https://t.me/' + t.channel + '/' + id };
    }
  } catch { /* not reachable */ }
  return null;
}
