// Streamlink (owner, 18.11): its site plugins find the stream address of
// pages yt-dlp does not know, mostly live broadcasts. Only the address is
// taken here; the download itself is done by the usual tools.
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';

export function streamlinkPath(env = process.env) {
  if (env.STREAMLINK_PATH && existsSync(env.STREAMLINK_PATH)) return env.STREAMLINK_PATH;
  for (const p of ['/usr/local/bin/streamlink', '/usr/bin/streamlink']) if (existsSync(p)) return p;
  return null;
}

// Page -> { url, headers } of its best stream, or null.
export function streamlinkResolve(pageUrl, { timeoutMs = 15000, bin = streamlinkPath() } = {}) {
  if (!bin || !/^https?:\/\//i.test(String(pageUrl || ''))) return Promise.resolve(null);
  return new Promise(resolve => {
    const p = spawn(bin, ['--json', '--http-timeout', '10', pageUrl, 'best'], { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    const t = setTimeout(() => { p.kill('SIGKILL'); resolve(null); }, timeoutMs);
    p.stdout.on('data', d => { out += d; if (out.length > 2e6) p.kill('SIGKILL'); });
    p.on('error', () => { clearTimeout(t); resolve(null); });
    p.on('close', () => {
      clearTimeout(t);
      try {
        const j = JSON.parse(out);
        if (!j?.url || !/^https?:/i.test(j.url)) return resolve(null);
        const h = j.headers || {};
        resolve({ url: j.url, type: j.type || null, headers: { ...(h['User-Agent'] ? { 'User-Agent': h['User-Agent'] } : {}), ...(h.Referer ? { Referer: h.Referer } : {}), ...(h.Origin ? { Origin: h.Origin } : {}) } });
      } catch { resolve(null); }
    });
  });
}

// Installs/updates Streamlink once at startup (pip, system Python).
export async function ensureStreamlink({ log = console } = {}) {
  if (streamlinkPath()) return true;
  const ok = await new Promise(resolve => {
    const p = spawn('python3', ['-m', 'pip', 'install', '--break-system-packages', '--upgrade', '--quiet', 'streamlink'], { stdio: ['ignore', 'ignore', 'pipe'] });
    let tail = ''; p.stderr.on('data', d => { tail = (tail + d).slice(-400); });
    const t = setTimeout(() => p.kill('SIGKILL'), 10 * 60000);
    p.on('close', code => { clearTimeout(t); if (code) log.warn?.('[STREAMLINK] install failed', { code, tail: tail.replace(/\s+/g, ' ').slice(-200) }); resolve(code === 0); });
    p.on('error', () => { clearTimeout(t); resolve(false); });
  });
  log.info?.('[STREAMLINK] install finished', { ok, path: streamlinkPath() });
  return ok && !!streamlinkPath();
}
