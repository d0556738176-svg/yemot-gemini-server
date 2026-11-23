import os from 'node:os';
// Browser engine for extension 2 (owner, 18.11: "the most advanced engine,
// downloading from as many sites as possible"). A page the downloader cannot
// read is opened in a real (headless) Chromium, the way a person's browser
// opens it: its scripts run, its player is started, and the media addresses
// the page itself requests (HLS/DASH playlists, mp4/mp3 files) are collected.
// The download is then done by the usual tools (N_m3u8DL-RE / yt-dlp).
// Only what the public page plays for any visitor: no login, no paywall, and
// encrypted (DRM) media is not decrypted. Cookies the page set stay in memory
// for that one download and are never saved.
import { existsSync, readdirSync } from 'node:fs';
import path from 'node:path';

export const BROWSER_DIR = process.env.PLAYWRIGHT_BROWSERS_PATH || '/opt/yemot/browser';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36';
const MEDIA_EXT = /\.(?:m3u8|mpd|livx|isml?\/manifest|mp4|m4a|m4v|mp3|aac|ogg|opus|webm|flac|wav)(?:[?#]|$)/i;
const SEGMENT = /(?:\.(?:ts|m4s)(?:[?#]|$))|(?:[/_-](?:seg|segment|chunk|frag)[-_]?\d+)|(?:\binit\.mp4)|(?:\/range\/\d)/i;
const MEDIA_TYPE = /^(?:video\/|audio\/|application\/(?:vnd\.apple\.mpegurl|x-mpegurl|dash\+xml))/i;
const ADS = /doubleclick|googlesyndication|googleads|imasdk|adservice|adnxs|taboola|outbrain|spotx|springserve|teads|innovid|moatads|vidazoo|aniview|connatix|primis|\/ads?\//i;

// The browser that is used: an explicit path, else Playwright's own download.
export function browserPath(env = process.env) {
  if (env.BROWSER_PATH && existsSync(env.BROWSER_PATH)) return env.BROWSER_PATH;
  try {
    for (const d of readdirSync(BROWSER_DIR).sort().reverse()) {
      for (const rel of ['chrome-linux/headless_shell', 'chrome-headless-shell-linux64/chrome-headless-shell', 'chrome-linux/chrome', 'chrome-linux64/chrome']) {
        const p = path.join(BROWSER_DIR, d, rel);
        if (existsSync(p)) return p;
      }
    }
  } catch { /* not installed */ }
  return null;
}
export const browserAvailable = (env = process.env) => String(env.BROWSER_ENGINE || 'on') !== 'off' && !!browserPath(env);

// Which of the requests is the media itself: a whole playlist first (it holds
// every quality), then the biggest file; pieces of a playlist and adverts never.
export function rankMedia(found) {
  const score = m => {
    if (ADS.test(m.url)) return -1;
    if (SEGMENT.test(m.url) && !/\.(?:m3u8|mpd)/i.test(m.url)) return -1;
    if (/\.m3u8|mpegurl/i.test(m.url + ' ' + (m.type || ''))) return /master|index|playlist|manifest/i.test(m.url) ? 100 : 90;
    if (/\.mpd|\.livx|\/manifest|dash\+xml/i.test(m.url + ' ' + (m.type || ''))) return 85;
    const len = Number(m.length) || 0;
    if (len && len < 300 * 1024) return -1; // a short sound / preview, not the recording
    return 50 + Math.min(30, Math.floor(len / (20 * 1024 * 1024)));
  };
  return found.map(m => ({ ...m, score: score(m) })).filter(m => m.score >= 0).sort((a, b) => b.score - a.score);
}

// One browser (the server is small), at most two pages at once; it closes
// itself when idle.
let browser = null, closing = null, idleTimer = null, launching = null;
async function getBrowser(env) {
  clearTimeout(idleTimer);
  if (closing) await closing.catch(() => {});
  if (browser?.isConnected()) return browser;
  if (launching) return launching;
  const { chromium } = await import('playwright-core');
  launching = chromium.launch({ executablePath: browserPath(env), headless: true,
    args: ['--no-sandbox', '--disable-dev-shm-usage', '--autoplay-policy=no-user-gesture-required', '--mute-audio', '--disable-gpu', '--no-zygote', '--js-flags=--max-old-space-size=256'] })
    .then(b => { browser = b; return b; }).finally(() => { launching = null; });
  return launching;
}
export const browserEvents = [];
let busy = 0;
const waiting = [];
function idleClose() {
  clearTimeout(idleTimer);
  if (busy) return;
  idleTimer = setTimeout(() => { const b = browser; browser = null; closing = b?.close().catch(() => {}) || null; }, 90000);
  idleTimer.unref?.();
}
async function slot(fn) {
  // 23.11: one page at a time on a 2-core server (each page is a whole browser tab).
  const max = Math.max(1, Number(process.env.BROWSER_PAGES) || (os.cpus().length <= 2 ? 1 : 2));
  if (busy >= max) await new Promise(r => waiting.push(r));
  busy++;
  try { return await fn(); } finally { busy--; waiting.shift()?.(); idleClose(); }
}

// Opens the page, starts its player and returns what it played:
// { media: [{url, type, length, headers}], title, image, durationSec }.
// `deadline` (a time) stops a page that waited for its turn too long.
export function sniffPage(pageUrl, { timeoutMs = 25000, deadline = Infinity, env = process.env, log = console } = {}) {
  if (!/^https?:\/\//i.test(String(pageUrl || '')) || !browserAvailable(env)) return Promise.resolve(null);
  return slot(() => {
    const t0 = Date.now(), limit = Math.min(timeoutMs, deadline - t0);
    if (limit < 6000) return null;
    // A hard limit: a page full of advert frames can hang a call inside the
    // browser (c14.co.il took 3 minutes); the page is closed when it is up.
    let kill;
    const hard = new Promise(r => { kill = setTimeout(() => r('timeout'), limit + 4000); });
    const work = sniffOnce(pageUrl, limit, env, log, ctxOut => { work.ctx = ctxOut; });
    return Promise.race([work, hard]).then(async r => {
      clearTimeout(kill);
      if (r === 'timeout') { log.warn?.('[BROWSER] page hard timeout', { ms: Date.now() - t0 }); await work.ctx?.close().catch(() => {}); return work.partial?.() || null; }
      return r;
    });
  });
}

async function sniffOnce(pageUrl, timeoutMs, env, log, onCtx) {
  {
    const started = Date.now();
    const b = await getBrowser(env);
    const ctx = await b.newContext({ userAgent: UA, locale: 'he-IL', viewport: { width: 1280, height: 720 }, ignoreHTTPSErrors: true });
    onCtx(ctx);
    const found = new Map();
    const note = async (req, res) => {
      try {
        const url = req.url();
        if (!/^https?:/i.test(url) || found.has(url)) return;
        const type = res ? (res.headers()['content-type'] || '') : '';
        if (!MEDIA_EXT.test(url) && !MEDIA_TYPE.test(type)) return;
        const h = await req.allHeaders().catch(() => req.headers());
        found.set(url, { url, type, length: res ? Number(res.headers()['content-length']) || 0 : 0,
          headers: { 'User-Agent': h['user-agent'] || UA, ...(h.referer ? { Referer: h.referer } : {}), ...(h.origin ? { Origin: h.origin } : {}) } });
      } catch { /* a closed page */ }
    };
    try {
      // Pictures and fonts are not needed: less memory, faster pages.
      await ctx.route('**/*', r => ['image', 'font'].includes(r.request().resourceType()) ? r.abort() : r.continue());
      ctx.on('request', r => { void note(r, null); });
      ctx.on('response', r => { void note(r.request(), r); });
      const page = await ctx.newPage();
      const left = () => timeoutMs - (Date.now() - started);
      await page.goto(pageUrl, { waitUntil: 'domcontentloaded', timeout: Math.max(5000, left() - 3000) }).catch(() => {});
      const wantMore = () => !rankMedia([...found.values()]).some(m => m.score >= 85);
      // Start the player the way a person would: play every video/audio in
      // every frame, then click the usual play buttons.
      for (let round = 0; round < 6 && left() > 1500 && wantMore(); round++) {
        for (const f of page.frames()) {
          await Promise.race([f.evaluate(() => { for (const m of document.querySelectorAll('video,audio')) { try { m.muted = true; const p = m.play(); p?.catch?.(() => {}); } catch {} } }).catch(() => {}), new Promise(r => setTimeout(r, 1500))]);
          if (left() < 1500) break;
        }
        if (round === 1 || round === 3) {
          for (const sel of ['button[aria-label*="play" i]', '[class*="play" i]:not(a[href])', '.vjs-big-play-button', '.jw-icon-playback', '.plyr__control--overlaid', '[data-testid*="play" i]', 'video']) {
            for (const f of page.frames()) {
              const el = await Promise.race([f.$(sel).catch(() => null), new Promise(r => setTimeout(() => r(null), 1000))]);
              if (el) { await el.click({ timeout: 1500, force: true }).catch(() => {}); break; }
            }
          }
        }
        await page.waitForTimeout(Math.min(2500, Math.max(0, left() - 1000)));
      }
      const info = await Promise.race([new Promise(r => setTimeout(() => r({}), 2000)), page.evaluate(() => {
        const meta = n => document.querySelector('meta[property="' + n + '"],meta[name="' + n + '"]')?.content || null;
        const v = document.querySelector('video,audio');
        return { title: meta('og:title') || document.title || null, image: meta('og:image'), durationSec: v && Number.isFinite(v.duration) ? Math.round(v.duration) : null };
      }).catch(() => ({}))]);
      // Cookies the page set, for this one download only (never stored).
      const cookies = await ctx.cookies().catch(() => []);
      const media = rankMedia([...found.values()]).slice(0, 6).map(m => {
        let host = ''; try { host = new URL(m.url).hostname; } catch {}
        const c = cookies.filter(k => host === k.domain.replace(/^\./, '') || host.endsWith(k.domain.startsWith('.') ? k.domain : '.' + k.domain)).map(k => k.name + '=' + k.value).join('; ');
        return { url: m.url, type: m.type, length: m.length, headers: m.headers, cookie: c || null };
      });
      browserEvents.push({ at: new Date().toISOString(), page: (() => { try { const u = new URL(pageUrl); return u.hostname + u.pathname.slice(0, 60); } catch { return ''; } })(), requests: found.size, media: media.map(m => m.url.replace(/\?.*/, '').slice(-70)), ms: Date.now() - started });
      if (browserEvents.length > 60) browserEvents.shift();
      log.info?.('[BROWSER] page opened', { host: (() => { try { return new URL(pageUrl).hostname; } catch { return ''; } })(), media: media.length, first: media[0]?.url.replace(/\?.*/, '').slice(0, 120) || null, ms: Date.now() - started });
      return { media, title: String(info.title || '').replace(/\s+/g, ' ').trim().slice(0, 200) || null, image: info.image || null, durationSec: info.durationSec || null };
    } catch (e) {
      log.warn?.('[BROWSER] page failed', { message: String(e?.message || e).slice(0, 160) });
      return null;
    } finally {
      await ctx.close().catch(() => {});
    }
  }
}

// Installs Chromium for this engine once (owner, 18.11), in the background at
// startup; nothing else waits for it. Re-run only when it is missing.
export async function ensureBrowserInstalled({ log = console, env = process.env } = {}) {
  if (String(env.BROWSER_ENGINE || 'on') === 'off' || browserPath(env)) return true;
  const { spawn } = await import('node:child_process');
  const { createRequire } = await import('node:module');
  let cli;
  try { cli = path.join(path.dirname(createRequire(import.meta.url).resolve('playwright-core/package.json')), 'cli.js'); } catch { log.warn?.('[BROWSER] playwright-core missing'); return false; }
  log.info?.('[BROWSER] installing Chromium for the browser engine', { dir: BROWSER_DIR });
  const ok = await new Promise(resolve => {
    const p = spawn(process.execPath, [cli, 'install', '--with-deps', '--only-shell', 'chromium'], { env: { ...process.env, PLAYWRIGHT_BROWSERS_PATH: BROWSER_DIR, DEBIAN_FRONTEND: 'noninteractive' }, stdio: ['ignore', 'pipe', 'pipe'] });
    let tail = '';
    p.stdout.on('data', d => { tail = (tail + d).slice(-600); });
    p.stderr.on('data', d => { tail = (tail + d).slice(-600); });
    const t = setTimeout(() => p.kill('SIGKILL'), 20 * 60000);
    p.on('close', code => { clearTimeout(t); if (code) log.warn?.('[BROWSER] install failed', { code, tail: tail.replace(/\s+/g, ' ').slice(-300) }); resolve(code === 0); });
    p.on('error', () => { clearTimeout(t); resolve(false); });
  });
  log.info?.('[BROWSER] install finished', { ok, path: browserPath(env) });
  return ok && !!browserPath(env);
}
