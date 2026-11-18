// Live check of the web download engines on this server (owner, 18.11),
// run once in the background after each new version starts. For a list of
// searches it finds real pages, resolves each with the full chain (yt-dlp,
// page scan, Streamlink, browser engine) and proves the media really
// downloads by saving its first 20 seconds to a temporary file (deleted at
// once). Nothing goes to Yemot. Results: /branch2-diag -> engineTest.
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

export const state = { status: 'idle', startedAt: null, finishedAt: null, engines: null, sites: [] };

const QUERIES = ['פרק מלא כאן 11', 'פרק מלא מאקו קשת', 'רשת 13 פרק מלא', 'שיעור תורה הידברות', 'שיעור יוטורה', 'כיכר השבת וידאו', 'קול חי שיעור', 'וואלה וידאו', 'ynet וידאו', 'i24news', 'dailymotion', 'vimeo', 'soundcloud', 'archive.org', '103fm תוכנית'];

function version(bin, args = ['--version']) {
  try { const r = spawnSync(bin, args, { encoding: 'utf8', timeout: 15000 }); return (r.stdout || r.stderr || '').split('\n').find(Boolean)?.trim().slice(0, 60) || null; } catch { return null; }
}

function grab20(item, cookie, ffmpegPath) {
  return new Promise(async resolve => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'engtest-'));
    const out = path.join(dir, 'x.mkv');
    const h = { ...(item.httpHeaders || {}), ...(item.referer ? { Referer: item.referer } : {}), ...(cookie ? { Cookie: cookie } : {}) };
    const headers = Object.entries(h).map(([k, v]) => k + ': ' + v + '\r\n').join('');
    const p = spawn(ffmpegPath, ['-hide_banner', '-loglevel', 'error', '-y', ...(headers ? ['-headers', headers] : []), '-i', item.url, '-t', '20', '-map', '0:a:0?', '-map', '0:v:0?', '-c', 'copy', out], { stdio: ['ignore', 'ignore', 'pipe'] });
    let err = ''; p.stderr.on('data', d => { err = (err + d).slice(-300); });
    const t = setTimeout(() => p.kill('SIGKILL'), 90000);
    p.on('close', async () => {
      clearTimeout(t);
      const size = (await fs.stat(out).catch(() => ({ size: 0 }))).size;
      await fs.rm(dir, { recursive: true, force: true });
      resolve({ ok: size > 20000, bytes: size, err: size > 20000 ? null : err.replace(/\s+/g, ' ').slice(-160) });
    });
  });
}

export async function runEngineSelfTest({ env = process.env, log = console, ffmpegPath = 'ffmpeg' } = {}) {
  if (state.status === 'running') return state;
  Object.assign(state, { status: 'running', startedAt: new Date().toISOString(), finishedAt: null, sites: [] });
  const { ytdlpPath } = await import('./youtube-direct.js');
  const { streamDownloaderPath } = await import('./stream-media-download.js');
  const { browserPath } = await import('./browser-media.js');
  const { streamlinkPath } = await import('./streamlink-media.js');
  state.engines = {
    ytdlp: version(ytdlpPath()), nm3u8: streamDownloaderPath() ? version(streamDownloaderPath()) || 'installed' : null,
    streamlink: streamlinkPath() ? version(streamlinkPath()) : null, browser: browserPath() || null,
  };
  const web = await import('./web-media.js');
  for (const q of QUERIES) {
    const row = { q, candidates: 0, checked: [], found: 0 };
    state.sites.push(row);
    try {
      const list = (await web.webCandidates(q, { env })).filter(c => !/youtube\.com|youtu\.be/i.test(c.url)).slice(0, 4);
      row.candidates = list.length;
      for (const c of list) {
        const t0 = Date.now();
        let failure = null;
        const it = await web.inspectLink(c, { timeoutMs: 30000, browserMs: 30000, onFailure: f => { failure = f.reason; } }).catch(() => null);
        const host = (() => { try { return new URL(c.url).hostname.replace(/^www\./, ''); } catch { return ''; } })();
        if (!it || it.youtube) { row.checked.push({ host, ok: false, why: it?.youtube ? 'youtube' : failure || 'no media', sec: Math.round((Date.now() - t0) / 1000) }); continue; }
        const g = it.live ? { ok: true, bytes: 0, err: null } : await grab20(it, null, ffmpegPath);
        row.checked.push({ host, ok: g.ok, engine: it.browser ? 'browser/streamlink' : 'yt-dlp', live: !!it.live, sec: Math.round((Date.now() - t0) / 1000), title: String(it.title || '').slice(0, 60), ...(g.ok ? {} : { why: g.err }) });
        if (g.ok) row.found++;
      }
    } catch (e) { row.error = String(e?.message || e).slice(0, 120); }
    log.info?.('[ENGINE_TEST] search', { q, candidates: row.candidates, ok: row.found });
  }
  Object.assign(state, { status: 'done', finishedAt: new Date().toISOString() });
  return state;
}
