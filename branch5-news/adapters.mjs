import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { spawn } from 'node:child_process';
import { pathToFileURL } from 'node:url';

export async function readEnv(file) {
  const result = {};
  for (const line of (await fs.readFile(file, 'utf8')).split(/\r?\n/)) {
    const m = line.match(/^([A-Z][A-Z0-9_]*)=(.*)$/);
    if (m) result[m[1]] = m[2].replace(/^"(.*)"$/, '$1').replace(/^'(.*)'$/, '$1');
  }
  return result;
}

export function youtubeAPI(keys, fetchImpl = fetch) {
  const unique = [...new Set(keys.filter(Boolean))];
  const cooldown = new Map();
  return async (method, params) => {
    if (!['channels', 'playlistItems', 'videos'].includes(method)) throw Error('method_not_allowed');
    for (const key of unique) {
      if ((cooldown.get(key) || 0) > Date.now()) continue;
      const url = new URL('https://www.googleapis.com/youtube/v3/' + method);
      url.search = new URLSearchParams({ ...params, key });
      const r = await fetchImpl(url, { signal: AbortSignal.timeout(15000) });
      if (r.ok) return r.json();
      if ([403, 429].includes(r.status)) { await r.body?.cancel(); cooldown.set(key, Date.now() + 3600000); continue; }
      throw Object.assign(Error('youtube_metadata_http_' + r.status), { code: 'youtube_metadata_failed' });
    }
    throw Object.assign(Error('youtube_metadata_quota_or_key_missing'), { code: 'youtube_quota' });
  };
}

export async function resourceAvailable(workDir, { minFreeBytes = 2 * 1024 ** 3, maxLoad = Math.max(1, os.cpus().length * .6) } = {}) {
  const disk = await fs.statfs(workDir);
  if (disk.bavail * disk.bsize < minFreeBytes || os.loadavg()[0] > maxLoad) return false;
  // Give already-running media jobs outside this isolated service precedence.
  const selfGroup = await fs.readFile('/proc/self/cgroup', 'utf8').catch(() => '');
  for (const name of await fs.readdir('/proc')) {
    if (!/^\d+$/.test(name)) continue;
    const cmd = await fs.readFile('/proc/' + name + '/comm', 'utf8').catch(() => '');
    if (!/yt-dlp|ffmpeg/.test(cmd)) continue;
    const group = await fs.readFile('/proc/' + name + '/cgroup', 'utf8').catch(() => '');
    if (group !== selfGroup) return false;
  }
  return true;
}

function ffmpeg(bin, args, signal) {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, { stdio: 'ignore', signal });
    child.on('error', reject);
    child.on('close', code => code === 0 ? resolve() : reject(Error('conversion_failed')));
  });
}

// The only media downloader imported is the exact free module already used by
// extension 2. No generic playback pipeline, alternate source or paid resolver.
export async function freeDownloader({ modulePath, workDir, api, signal, downloadImpl, bin = '/usr/local/bin/yt-dlp', ffmpegPath = '/usr/bin/ffmpeg' }) {
  const directDownload = downloadImpl || (await import(pathToFileURL(modulePath).href)).directDownload;
  if (typeof directDownload !== 'function') throw Error('extension2_free_downloader_missing');
  return async job => {
    const facts = await api('videos', { part: 'snippet,liveStreamingDetails', id: job.id });
    const video = facts.items?.[0];
    if (!video || video.snippet?.liveBroadcastContent === 'upcoming' || video.snippet?.liveBroadcastContent === 'live') {
      throw Object.assign(Error('not_ready'), { code: 'video_not_ready' });
    }
    const dir = await fs.mkdtemp(path.join(workDir, 'item-'));
    const cleanup = () => fs.rm(dir, { recursive: true, force: true });
    const controller = new AbortController();
    const abort = () => controller.abort();
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) abort();
    // A stalled/very large item never monopolizes the worker indefinitely.
    const timer = setTimeout(abort, 30 * 60000);
    const space = setInterval(async () => {
      try { const d = await fs.statfs(workDir); if (d.bavail * d.bsize < 1024 ** 3) abort(); }
      catch { abort(); }
    }, 10000);
    try {
      const input = path.join(dir, 'source.audio');
      await directDownload(job.id, input, {
        mode: 'audio', bin, ffmpegPath, signal: controller.signal, withCaptions: false,
        maxBytes: 512 * 1024 ** 2, stallMs: 45000,
        // Avoid including upstream stderr (which may contain signed URLs).
        log: { info() {}, warn() {} },
      });
      await ffmpeg(ffmpegPath, ['-nostdin', '-hide_banner', '-loglevel', 'error', '-y', '-threads', '1', '-i', input,
        '-vn', '-ar', '8000', '-ac', '1', '-c:a', 'pcm_s16le', '-f', 'segment', '-segment_time', '60',
        path.join(dir, 'part-%05d.wav')], controller.signal);
      const files = (await fs.readdir(dir)).filter(x => /^part-\d{5}\.wav$/.test(x)).sort().map(x => path.join(dir, x));
      if (!files.length) throw Error('no_audio');
      return { files, cleanup };
    } catch (e) { await cleanup(); throw e; }
    finally { clearInterval(space); clearTimeout(timer); signal?.removeEventListener('abort', abort); }
  };
}

export function yemotClient(env, fetchImpl = fetch) {
  const token = env.YEMOT_API_USERNAME && env.YEMOT_API_PASSWORD ? env.YEMOT_API_USERNAME + ':' + env.YEMOT_API_PASSWORD : env.YEMOT_TOKEN;
  if (!token) throw Error('yemot_credentials_missing');
  const endpoint = 'https://www.call2all.co.il/ym/api/';
  async function request(method, params, body) {
    const url = new URL(endpoint + method);
    url.search = new URLSearchParams({ token, ...params });
    const r = await fetchImpl(url, { method: body ? 'POST' : 'GET', ...(body ? { body } : {}), signal: AbortSignal.timeout(45000) });
    const data = await r.json();
    if (!r.ok || data.responseStatus !== 'OK') throw Object.assign(Error('yemot_' + method + '_failed'), { code: 'yemot_unavailable' });
    return data;
  }
  return {
    async publish(job, media) {
      const paths = [];
      for (let i = 0; i < media.files.length; i++) {
        const stem = '/5/news/' + job.id + '-' + String(i).padStart(5, '0');
        const remote = 'ivr2:' + stem + '.wav';
        const wav = await fs.readFile(media.files[i]);
        const form = new FormData();
        form.append('file', new Blob([wav], { type: 'audio/wav' }), 'news.wav');
        await request('UploadFile', { path: remote, convertAudio: '0', autoNumbering: 'false' }, form);
        const result = await request('GetFile', { what: remote });
        if (result.file?.exists !== true || Number(result.file?.size) !== wav.length) throw Error('upload_not_verified');
        paths.push(stem);
      }
      return paths;
    },
    async getExtension() { return (await request('GetTextFile', { what: 'ivr2:/5/ext.ini' })).contents; },
    async activate(apiLink) {
      if (!apiLink.startsWith('https://')) throw Error('https_required');
      // This client can configure only /5. No root/menu or other extension writes.
      const form = new URLSearchParams({ token, what: 'ivr2:/5/ext.ini', contents: 'type=api\napi_link=' + apiLink + '\ntitle=עדכוני חדשות\n' });
      const r = await fetchImpl(endpoint + 'UploadTextFile', { method: 'POST', body: form, signal: AbortSignal.timeout(15000) });
      if (!r.ok || (await r.json()).responseStatus !== 'OK') throw Error('activation_failed');
    },
  };
}
