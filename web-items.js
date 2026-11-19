// Videos and recordings from any website (owner, 18.11: extension 2 keys 5/6/3
// and extensions 1/3). Each link gets an 11-character id ("w" + 10 from its
// hash), so the whole YouTube pipeline (phone audio, download copies,
// folders, progress, background jobs, resuming after a restart) works on it
// unchanged; the pieces that fetch from YouTube ask this registry first.
// Kept in Yemot's storage too, so a download resumed after a restart still
// knows its link.
import { createHash } from 'node:crypto';
import { siteName } from './branch2-web-flow.js';

const PATH = 'ivr2:/2/youtubeaudio/web_items.json';
const items = new Map();
let store = null, loaded = null, saveTimer = null;

export const webIdFor = url => 'w' + createHash('sha1').update(String(url)).digest('base64url').replace(/[^A-Za-z0-9]/g, '').slice(0, 10);

export function useStore(s) { store = s; }

async function load() {
  if (!loaded) loaded = (async () => {
    try {
      const data = store ? await store.read(PATH) : null;
      for (const x of Array.isArray(data?.items) ? data.items : []) if (x?.id && x?.url && !items.has(x.id)) items.set(x.id, x);
    } catch { /* starts empty */ }
  })();
  return loaded;
}

function save() {
  if (!store) return;
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    const list = [...items.values()].sort((a, b) => String(b.at).localeCompare(String(a.at))).slice(0, 2000);
    store.write(PATH, { items: list }).catch(() => {});
  }, 1500);
  saveTimer.unref?.();
}

// item: { url, title, site, uploader, description, thumbnail, durationSec, uploadDate, hasVideo, hasAudio }
export function registerWebItem(item) {
  const url = String(item?.url || '').trim();
  if (!/^https?:\/\//i.test(url)) return null;
  // 19.11: the id comes from the PAGE when there is one, so the same
  // recording found again (its file address carries a fresh token each
  // time) is the same item, and a file already saved plays at once.
  const page = String(item?.page || '').trim();
  const id = webIdFor(/^https?:\/\//i.test(page) ? page : url);
  const legacyId = id !== webIdFor(url) ? webIdFor(url) : null;
  items.set(id, { ...(items.get(id) || {}), ...item, url, id, ...(legacyId && !items.get(id)?.legacyId ? { legacyId } : {}), at: new Date().toISOString() });
  save();
  return id;
}

export const isWebId = id => /^w[A-Za-z0-9]{10}$/.test(String(id || '')) && items.has(String(id));

export async function webItem(id) {
  const k = String(id || '');
  if (!/^w[A-Za-z0-9]{10}$/.test(k)) return null;
  if (!items.has(k)) await load();
  return items.get(k) || null;
}

// The same shape fetchVideoFacts gives for YouTube, from the site's own details.
export function webFacts(w) {
  if (!w) return null;
  const d = String(w.uploadDate || '');
  const publishedAt = /^\d{8}$/.test(d) ? d.slice(0, 4) + '-' + d.slice(4, 6) + '-' + d.slice(6, 8) + 'T00:00:00Z' : null;
  return {
    durationSeconds: Number(w.durationSec) || null, publishedAt, viewCount: Number.isFinite(w.views) ? w.views : null,
    // The site by its own name ("הידברות", not "hidabroot.org"), 19.11.
    title: w.title || null, channel: w.uploader || (w.site ? siteName(w.site) : null), description: w.description || null,
    tags: Array.isArray(w.tags) ? w.tags : null, categoryId: null, audioLanguage: null, hasCaptions: false,
    regionAllowed: null, regionBlocked: null, webUrl: w.page || w.url, site: w.site ? siteName(w.site) : null,
  };
}
export const _test = { items, load: () => { loaded = null; return load(); } };
