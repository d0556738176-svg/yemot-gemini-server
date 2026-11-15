// Keeps the Yemot extensions pointing at this server.
//
// The system moved from Render to its own server (Empire IL). If an old Render
// service ever wakes up (for example when Render's free quota resets) it would
// rewrite the extensions back to *.onrender.com. Every 10 minutes this guard
// reads the extension settings and puts back any onrender.com address, so calls
// never stay on the old servers. It runs only off Render and only when
// PUBLIC_BASE_URL is set.
import { yemotToken } from './song-ext7.js';

const API = 'https://www.call2all.co.il/ym/api';
const PATHS = ['1', '2', '3', '4', '5', '6', '7', '8', '9']
  .flatMap(p => [p, ...(['2', '6'].includes(p) ? '123456789'.split('').map(s => p + '/' + s) : [])]);

// main.<ip>.sslip.io -> ext2.<ip>.sslip.io (both apps run on this server).
export function linkTargets(publicUrl, ext2Url = '') {
  const main = String(publicUrl || '').replace(/\/+$/, '');
  let ext2 = String(ext2Url || '').replace(/\/+$/, '');
  if (!ext2 && /^https:\/\/main\./.test(main)) ext2 = main.replace(/^https:\/\/main\./, 'https://ext2.');
  return { main, ext2 };
}

// Replace every onrender.com origin in an ext.ini. Extension-2 services go to
// ext2, everything else to main. Returns null when nothing changes.
export function rewriteIni(text, { main, ext2 }) {
  const out = String(text).replace(/https:\/\/([a-z0-9-]+)\.onrender\.com/gi, (_, name) =>
    (/branch2|branch-2/i.test(name) && ext2) ? ext2 : main);
  return out === String(text) ? null : out;
}

export async function guardOnce({ log = console, fetchImpl = fetch } = {}) {
  const token = yemotToken();
  const targets = linkTargets(process.env.PUBLIC_BASE_URL, process.env.YEMOT_EXT2_BASE_URL);
  if (!token || !targets.main) return { checked: 0, fixed: [] };
  const fixed = [];
  let checked = 0;
  for (const p of PATHS) {
    const what = 'ivr2:/' + p + '/ext.ini';
    const j = await fetchImpl(API + '/GetTextFile?' + new URLSearchParams({ token, what }), { signal: AbortSignal.timeout(15000) })
      .then(r => r.json()).catch(() => null);
    if (j?.responseStatus !== 'OK' || typeof j.contents !== 'string') continue;
    checked++;
    const next = rewriteIni(j.contents, targets);
    if (!next) continue;
    const up = await fetchImpl(API + '/UploadTextFile', { method: 'POST', body: new URLSearchParams({ token, what, contents: next }), signal: AbortSignal.timeout(15000) })
      .then(r => r.json()).catch(e => ({ message: String(e) }));
    if (up?.responseStatus === 'OK') fixed.push(p);
    else log.warn?.('[LINK GUARD] could not fix', { path: p, message: String(up?.message || '').slice(0, 120) });
  }
  if (fixed.length) log.warn?.('[LINK GUARD] moved extensions back from Render to this server', { fixed });
  return { checked, fixed };
}

export function startLinkGuard({ log = console, everyMs = 10 * 60 * 1000 } = {}) {
  if (process.env.RENDER || process.env.YEMOT_LINK_GUARD === 'off' || !process.env.PUBLIC_BASE_URL) return false;
  const run = () => guardOnce({ log }).catch(e => log.warn?.('[LINK GUARD] check failed', { message: String(e?.message || e).slice(0, 120) }));
  setTimeout(run, 60 * 1000).unref?.();
  setInterval(run, everyMs).unref?.();
  log.info?.('[LINK GUARD] watching Yemot extension links every ' + Math.round(everyMs / 60000) + ' minutes');
  return true;
}
