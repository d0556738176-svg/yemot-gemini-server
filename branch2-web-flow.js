// Extension 2, keys 5 / 6 / 3 (owner, 18.11): a search across the whole web,
// not only YouTube. Text pieces the call reads; the call itself is in server.js.

const SITES = {
  'hidabroot.org': 'הידברות', 'yutorah.org': 'יו תורה', 'kan.org.il': 'כאן', 'soundcloud.com': 'סאונדקלאוד',
  'dailymotion.com': 'דיילימושן', 'vimeo.com': 'וימאו', 'archive.org': 'ארכיון האינטרנט', 'facebook.com': 'פייסבוק',
  'instagram.com': 'אינסטגרם', 'youtube.com': 'יוטיוב', 'youtu.be': 'יוטיוב', 'music.youtube.com': 'יוטיוב מיוזיק',
  'kol-halashon.com': 'קול הלשון', 'kolhalashon.com': 'קול הלשון', 'meirtv.com': 'מאיר', 'meirtv.co.il': 'מאיר',
  'torahanytime.com': 'תורה אניטיים', 'jewishmusic.fm': 'ג\'ואיש מיוזיק', 'kikar.co.il': 'כיכר השבת', 'bhol.co.il': 'בחדרי חרדים',
  'mako.co.il': 'מאקו', '13tv.co.il': 'רשת 13', 'c14.co.il': 'ערוץ 14', 'ynet.co.il': 'ynet', 'walla.co.il': 'וואלה', 'i24news.tv': 'i24NEWS',
  'jdn.co.il': 'ג\'י די אן', 'behadrey.co.il': 'בחדרי חרדים', 'tiktok.com': 'טיקטוק', 'twitter.com': 'טוויטר', 'x.com': 'אקס',
};

export const WEB_PAGE_SIZE = 20;

// "hidabroot.org" -> "הידברות"; an unknown site by its name without the ending.
export function siteName(host) {
  const h = String(host || '').toLowerCase().replace(/^(?:www|m|he|il)\./, '');
  if (SITES[h]) return SITES[h];
  const k = Object.keys(SITES).find(x => h.endsWith('.' + x));
  if (k) return SITES[k];
  return h.replace(/\.(?:co|org|net|gov|ac)\.il$|\.(?:com|org|net|il|fm|tv|info|co|io|me)$/, '').replace(/[.-]+/g, ' ') || 'אתר';
}

export function lengthText(sec) {
  const s = Math.round(Number(sec) || 0);
  if (!s) return '';
  const h = Math.floor(s / 3600), m = Math.round((s % 3600) / 60);
  if (h) return 'אורך ' + (h === 1 ? 'שעה' : h === 2 ? 'שעתיים' : h + ' שעות') + (m ? ' ו ' + (m === 1 ? 'דקה' : m + ' דקות') : '');
  if (s < 60) return 'אורך ' + s + ' שניות';
  const mm = Math.round(s / 60);
  return 'אורך ' + (mm === 1 ? 'דקה' : mm + ' דקות');
}

export function youtubeIdOf(url) {
  const m = String(url || '').match(/(?:youtu\.be\/|[?&]v=|\/shorts\/|\/embed\/|\/live\/)([A-Za-z0-9_-]{11})/);
  return m ? m[1] : null;
}

// The results of one search as one list: the downloadable recordings found on
// other sites first, then YouTube links the search found (not repeated).
export function mergeResults(found) {
  const out = (found?.items || []).map(x => ({ videoId: x.id, title: x.title, site: x.site, durationSeconds: x.durationSec || null, hasVideo: !!x.hasVideo, web: true, live: !!x.live }));
  // Live broadcasts first when the caller asked for one.
  out.sort((a, b) => Number(b.live) - Number(a.live));
  const seen = new Set();
  for (const c of found?.youtube || []) {
    const id = youtubeIdOf(c.url);
    if (!id || seen.has(id)) continue;
    seen.add(id);
    out.push({ videoId: id, title: String(c.title || '').replace(/\s*-\s*YouTube\s*$/i, '').trim() || 'סרטון ביוטיוב', site: 'youtube.com', durationSeconds: null, hasVideo: true, web: false });
  }
  return out;
}

// "1, <title>, מאתר הידברות, אורך 12 דקות, שמע בלבד."
export function resultsPageText(items, start, size, { spoken = x => x } = {}) {
  return items.slice(start, start + size).map((x, i) =>
    (start + i + 1) + ', ' + spoken(x.title) + ', מאתר ' + siteName(x.site) + (x.live ? ', שידור חי עכשיו' : (lengthText(x.durationSeconds) ? ', ' + lengthText(x.durationSeconds) : '') + (x.hasVideo ? '' : ', שמע בלבד')) + '.'
  ).join(' ');
}

// What is said while the search runs.
export function searchProgressText(p, q, first) {
  if (first) return 'מחפש עכשיו בכל האתרים באינטרנט את ' + q + '. כל קישור נפתח ונבדק אם אפשר להוריד ממנו, וזה יכול לקחת עד דקה וחצי. לחזרה לתפריט הקש כוכבית.';
  if (p?.stage === 'checking' && p.total) return 'נבדקו ' + p.done + ' מתוך ' + p.total + ' קישורים. נמצאו עד עכשיו ' + p.found + ' הקלטות שאפשר להוריד. ממשיך לחפש, נא להמתין.';
  return 'מחפש באתרים, נא להמתין.';
}

export function noResultsText(found, q) {
  const failures = found?.unavailable || [];
  if (failures.some(x => x.reason === 'access_denied')) return 'נמצאו קישורים עבור ' + q + ', אבל האתר חסם את הגישה למדיה בבדיקה. כרגע אי אפשר להציע אותם להורדה. אפשר לנסות קישור אחר או לחפש שוב מאוחר יותר.';
  if (failures.some(x => x.reason === 'timeout')) return 'החיפוש עבור ' + q + ' מצא קישורים, אבל בדיקת המדיה לא הסתיימה בזמן. אפשר לנסות שוב.';
  return 'לא מצאתי באתרים הקלטה או סרטון שאפשר להוריד עבור ' + q + '. אפשר לנסות במילים אחרות.';
}
