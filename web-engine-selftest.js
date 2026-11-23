// Live check of the web download engines on this server (owner, 18.11),
// run once in the background after each new version starts. For a list of
// searches it finds real pages, resolves each with the full chain (yt-dlp,
// page scan, Streamlink, browser engine) and proves the media really
// downloads by saving its first 20 seconds to a temporary file (deleted at
// once). Nothing goes to Yemot. Results: /branch2-diag -> engineTest.
import { spawnSync } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

export const state = { status: 'idle', startedAt: null, finishedAt: null, engines: null, sites: [] };

const QUERIES = ['פרק מלא כאן 11', 'פרק מלא מאקו קשת', 'רשת 13 פרק מלא', 'שיעור תורה הידברות', 'שיעור יוטורה', 'כיכר השבת וידאו', 'קול חי שיעור', 'וואלה וידאו', 'ynet וידאו', 'i24news', 'dailymotion', 'vimeo', 'soundcloud', 'archive.org', '103fm תוכנית'];

function version(bin, args = ['--version']) {
  try { const r = spawnSync(bin, args, { encoding: 'utf8', timeout: 15000 }); return (r.stdout || r.stderr || '').split('\n').find(Boolean)?.trim().slice(0, 60) || null; } catch { return null; }
}

// The real download path (the same one a caller's key press runs), stopped
// as soon as real media data has arrived: proof without a whole episode.
async function grab(item, ffmpegPath) {
  const { directDownload } = await import('./youtube-direct.js');
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'engtest-'));
  const ac = new AbortController();
  let got = 0;
  const timer = setTimeout(() => ac.abort(), 120000);
  try {
    const r = await directDownload(item.id, path.join(dir, 'x.source'), { mode: 'audio', ffmpegPath, signal: ac.signal, withCaptions: false, log: { info() {}, warn() {} },
      onProgress: p => { got = Math.max(got, Number(p.done) || 0); const pct = p.total ? p.done / p.total : 0; if ((p.total === 100 && p.done >= 2) || (p.total > 100 && (p.done > 1.5e6 || pct >= 0.05))) { got = got || 1; ac.abort(); } } });
    return { ok: r.bytes > 20000, bytes: r.bytes, engine: r.client || 'yt-dlp' };
  } catch (e) {
    if (got && (e?.name === 'AbortError' || ac.signal.aborted)) return { ok: true, partial: true };
    return { ok: false, err: String(e?.message || e).replace(/\s+/g, ' ').slice(0, 160) };
  } finally { clearTimeout(timer); await new Promise(r => setTimeout(r, 1500)); await fs.rm(dir, { recursive: true, force: true }).catch(() => {}); }
}

export async function runEngineSelfTest({ env = process.env, log = console, ffmpegPath = 'ffmpeg', queries = QUERIES, perQuery = 3 } = {}) {
  if (state.status === 'running') return state;
  Object.assign(state, { status: 'running', startedAt: new Date().toISOString(), finishedAt: null, sites: [] });
  await (await import('./resource-guard.js')).waitForRoom({ label: 'engine check', maxWaitMs: 10 * 60000 });
  const { ytdlpPath } = await import('./youtube-direct.js');
  const { streamDownloaderPath } = await import('./stream-media-download.js');
  const { browserPath } = await import('./browser-media.js');
  const { streamlinkPath } = await import('./streamlink-media.js');
  state.engines = {
    ytdlp: version(ytdlpPath()), nm3u8: streamDownloaderPath() ? version(streamDownloaderPath()) || 'installed' : null,
    streamlink: streamlinkPath() ? version(streamlinkPath()) : null, browser: browserPath() || null,
  };
  const web = await import('./web-media.js');
  for (const q of queries) {
    const row = { q, candidates: 0, checked: [], found: 0 };
    state.sites.push(row);
    try {
      const list0 = await Promise.all((await web.webCandidates(q, { env })).map(async c => ({ ...c, url: await web.followGoogleRedirect(web.unwrapRedirect(c.url)) })));
      const list = list0.filter(c => !/youtube\.com|youtu\.be/i.test(web.unwrapRedirect(c.url))).slice(0, perQuery);
      row.candidates = list.length;
      for (const c of list) {
        const t0 = Date.now();
        let failure = null;
        const it = await web.inspectLink(c, { timeoutMs: 30000, browserMs: 30000, onFailure: f => { failure = f.reason; } }).catch(() => null);
        const host = (() => { try { return new URL(web.unwrapRedirect(c.url)).hostname.replace(/^www\./, ''); } catch { return ''; } })();
        if (!it || it.youtube) { row.checked.push({ host, ok: false, why: it?.youtube ? 'youtube' : failure || 'no media', sec: Math.round((Date.now() - t0) / 1000) }); continue; }
        const g = it.live ? { ok: true, bytes: 0, err: null } : await grab(it, ffmpegPath);
        row.checked.push({ host, ok: g.ok, engine: g.engine || (it.browser ? 'browser/streamlink' : 'yt-dlp'), found: it.browser ? 'browser/streamlink' : 'yt-dlp', live: !!it.live, sec: Math.round((Date.now() - t0) / 1000), title: String(it.title || '').slice(0, 60), ...(g.ok ? {} : { why: g.err }) });
        if (g.ok) row.found++;
      }
    } catch (e) { row.error = String(e?.message || e).slice(0, 120); }
    log.info?.('[ENGINE_TEST] search', { q, candidates: row.candidates, ok: row.found });
  }
  Object.assign(state, { status: 'done', finishedAt: new Date().toISOString() });
  return state;
}
