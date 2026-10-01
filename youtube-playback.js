import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { Readable, pipeline as pipelineCallback } from 'node:stream';
import { promisify } from 'node:util';
const pipeline = promisify(pipelineCallback);
import youtubedl from 'youtube-dl-exec';
import ffmpegPath from 'ffmpeg-static';

const YEMOT_UPLOAD_URL = 'https://www.call2all.co.il/ym/api/UploadFile';
const YTDLP_PLUGIN_ROOT = path.join(process.cwd(), 'node_modules', 'youtube-dl-exec', 'bin', 'yt-dlp-plugins', 'bgutil-ytdlp-pot-provider');
const activeJobs = new Map();
const CHUNK_SECONDS = 120;
const MAX_SOURCE_BYTES = 180 * 1024 * 1024;
const PIPED_INSTANCES = [
  'https://pipedapi.kavin.rocks',
  'https://pipedapi.adminforge.de',
  'https://pipedapi.reallyaweso.me',
  'https://pipedapi.drgns.space'
];
const INVIDIOUS_INSTANCES = [
  'https://inv.nadeko.net',
  'https://invidious.nerdvpn.de',
  'https://yt.chocolatemoo53.com',
  'https://invidious.tiekoetter.com'
];

function yemotApiKey() {
  const key = String(process.env.YEMOT_API_KEY || '').trim();
  if (!key) throw new Error('YEMOT_API_KEY is missing');
  return key;
}

async function uploadToYemot(filePath, remotePath) {
  const buffer = await fs.readFile(filePath);
  if (!buffer.length) throw new Error('Cannot upload an empty audio chunk');
  const url = new URL(YEMOT_UPLOAD_URL);
  url.searchParams.set('token', yemotApiKey());
  url.searchParams.set('path', remotePath);
  url.searchParams.set('convertAudio', '0');
  url.searchParams.set('autoNumbering', 'false');

  const form = new FormData();
  form.append('file', new Blob([buffer], { type: 'audio/wav' }), path.basename(filePath));
  const response = await fetch(url, { method: 'POST', body: form });
  const body = await response.text();
  if (!response.ok) throw new Error('Yemot UploadFile HTTP ' + response.status + ': ' + body.slice(0, 400));

  let result;
  try { result = JSON.parse(body); }
  catch { throw new Error('Yemot UploadFile returned invalid JSON: ' + body.slice(0, 400)); }

  if (result.responseStatus && result.responseStatus !== 'OK')
    throw new Error('Yemot UploadFile failed: ' + (result.message || result.responseStatus));
  if (result.success === false)
    throw new Error('Yemot UploadFile failed: ' + (result.message || 'unknown error'));
  return result;
}

async function tryDownload(url, output, client) {
  console.info('[YouTube playback] trying client', { client, videoId: path.basename(output, '.source.mp3') });
  const noPotClient = ['android', 'android_vr', 'tv', 'tv_simply', 'web_embedded'].includes(client);
  const extractorArgs = noPotClient
    ? 'youtube:player_client=' + client
    : [
        'youtube:player_client=' + client,
        'youtube:fetch_pot=always',
        'youtube:pot_trace=true',
        'youtubepot-bgutilhttp:base_url=http://127.0.0.1:4416'
      ].join(';');
  const format = client === 'android_vr' ? '18/bestaudio/best' : 'bestaudio/best';

  try {
    await youtubedl(url, {
      output,
      extractAudio: true,
      audioFormat: 'mp3',
      audioQuality: '7',
      format,
      noPlaylist: true,
      quiet: false,
      verbose: true,
      jsRuntimes: 'node',
      pluginDirs: YTDLP_PLUGIN_ROOT,
      extractorArgs,
      maxFilesize: '180M',
      ...(ffmpegPath ? { ffmpegLocation: ffmpegPath } : {})
    });
  } catch (error) {
    const stderr = String(error?.stderr || '').trim();
    const stdout = String(error?.stdout || '').trim();
    console.error('[YouTube playback] yt-dlp failure', {
      client,
      videoId: path.basename(output, '.source.mp3'),
      details: (stderr || stdout || error?.message || String(error)).slice(-5000)
    });
    throw error;
  }

  const stat = await fs.stat(output);
  if (!stat.size) throw new Error('yt-dlp produced an empty audio file');
  if (stat.size > MAX_SOURCE_BYTES) throw new Error('YouTube audio source is too large');
  console.info('[YouTube playback] downloaded source', { client, bytes: stat.size });
}

function runFfmpeg(args) {
  return new Promise((resolve, reject) => {
    if (!ffmpegPath) return reject(new Error('ffmpeg-static is unavailable'));
    const child = spawn(ffmpegPath, args, { stdio: ['ignore', 'ignore', 'pipe'] });
    let stderr = '';
    child.stderr.on('data', chunk => { stderr += chunk.toString(); if (stderr.length > 5000) stderr = stderr.slice(-5000); });
    child.on('error', reject);
    child.on('close', code => code === 0 ? resolve() : reject(new Error('ffmpeg failed (' + code + '): ' + stderr.slice(-1800))));
  });
}

async function makeChunks(source, chunkDir) {
  await fs.mkdir(chunkDir, { recursive: true });
  const pattern = path.join(chunkDir, 'chunk-%03d.wav');
  await runFfmpeg([
    '-hide_banner', '-loglevel', 'error', '-y',
    '-i', source,
    '-vn', '-ar', '8000', '-ac', '1',
    '-c:a', 'pcm_s16le',
    '-f', 'segment', '-segment_time', String(CHUNK_SECONDS), '-reset_timestamps', '1',
    pattern
  ]);
  const names = (await fs.readdir(chunkDir)).filter(n => /^chunk-\d{3}\.wav$/.test(n)).sort();
  if (!names.length) throw new Error('ffmpeg produced no audio chunks');
  return names.map(n => path.join(chunkDir, n));
}

async function tryPipedDownload(videoId, output) {
  let lastError;
  for (const instance of PIPED_INSTANCES) {
    try {
      console.info('[YouTube playback] trying Piped fallback', { instance, videoId });
      const response = await fetch(instance + '/streams/' + encodeURIComponent(videoId), {
        headers: { accept: 'application/json' },
        signal: AbortSignal.timeout(12000)
      });
      if (!response.ok) throw new Error('Piped HTTP ' + response.status);
      const data = await response.json();
      const candidates = Array.isArray(data.audioStreams)
        ? data.audioStreams.filter(x => x && x.url && !x.videoOnly)
        : [];
      candidates.sort((a, b) => {
        const ar = Number(a.bitrate || 0);
        const br = Number(b.bitrate || 0);
        return br - ar;
      });
      if (!candidates.length) throw new Error('Piped returned no audio streams');

      let mediaError;
      for (const media of candidates.slice(0, 3)) {
        try {
          const mediaResponse = await fetch(media.url, {
            headers: { accept: '*/*' },
            signal: AbortSignal.timeout(45000)
          });
          if (!mediaResponse.ok || !mediaResponse.body)
            throw new Error('Piped media HTTP ' + mediaResponse.status);
          await pipeline(Readable.fromWeb(mediaResponse.body), (await import('node:fs')).createWriteStream(output));
          const stat = await fs.stat(output);
          if (!stat.size) throw new Error('Piped produced an empty file');
          if (stat.size > MAX_SOURCE_BYTES) throw new Error('Piped audio source is too large');
          console.info('[YouTube playback] downloaded via Piped', {
            instance,
            bytes: stat.size,
            type: media.mimeType || media.format || 'unknown'
          });
          return;
        } catch (error) {
          mediaError = error;
          await fs.rm(output, { force: true }).catch(() => {});
        }
      }
      throw mediaError || new Error('Piped audio download failed');
    } catch (error) {
      lastError = error;
      console.warn('[YouTube playback] Piped instance failed', {
        instance,
        videoId,
        message: String(error?.message || error).slice(0, 1200)
      });
    }
  }
  throw new Error('Piped fallback failed: ' + String(lastError?.message || lastError || 'unknown error'));
}

async function tryInvidiousDownload(videoId, output) {
  let lastError;
  for (const instance of INVIDIOUS_INSTANCES) {
    try {
      const api = instance + '/api/v1/videos/' + encodeURIComponent(videoId) + '?fields=videoId,title,adaptiveFormats,formatStreams';
      console.info('[YouTube playback] trying Invidious fallback', { instance, videoId });
      const response = await fetch(api, { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(15000) });
      if (!response.ok) throw new Error('Invidious HTTP ' + response.status);
      const data = await response.json();

      const candidates = [
        ...(Array.isArray(data.adaptiveFormats) ? data.adaptiveFormats.filter(x => /^audio\\//i.test(String(x.type || '')) && x.url) : []),
        ...(Array.isArray(data.formatStreams) ? data.formatStreams.filter(x => /^(audio|video)\\//i.test(String(x.type || '')) && x.url) : [])
      ];
      candidates.sort((a, b) => {
        const aa = /^audio\\//i.test(String(a.type || '')) ? 0 : 1;
        const bb = /^audio\\//i.test(String(b.type || '')) ? 0 : 1;
        if (aa !== bb) return aa - bb;
        return Number(a.bitrate || 0) - Number(b.bitrate || 0);
      });
      if (!candidates.length) throw new Error('Invidious returned no playable formats');

      const media = candidates[0];
      const mediaResponse = await fetch(media.url, { signal: AbortSignal.timeout(30000) });
      if (!mediaResponse.ok || !mediaResponse.body) throw new Error('Invidious media HTTP ' + mediaResponse.status);
      await pipeline(Readable.fromWeb(mediaResponse.body), (await import('node:fs')).createWriteStream(output));
      const stat = await fs.stat(output);
      if (!stat.size) throw new Error('Invidious produced an empty file');
      if (stat.size > MAX_SOURCE_BYTES) throw new Error('Invidious audio source is too large');
      console.info('[YouTube playback] downloaded via Invidious', { instance, bytes: stat.size, type: media.type || 'unknown' });
      return;
    } catch (error) {
      lastError = error;
      console.warn('[YouTube playback] Invidious instance failed', { instance, videoId, message: String(error?.message || error).slice(0, 1200) });
      await fs.rm(output, { force: true }).catch(() => {});
    }
  }
  throw new Error('Invidious fallback failed: ' + String(lastError?.message || lastError || 'unknown error'));
}

async function buildYouTubePlayback(videoId) {
  const id = String(videoId || '').trim();
  if (!/^[A-Za-z0-9_-]{6,20}$/.test(id)) throw new Error('Invalid YouTube video id');

  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'yemot-youtube-'));
  const source = path.join(tempDir, id + '.source.mp3');
  const chunkDir = path.join(tempDir, 'chunks');
  const url = 'https://www.youtube.com/watch?v=' + id;
  const playbackPaths = [];

  try {
    let lastError;
    const failures = [];
    for (const client of ['android', 'tv_downgraded', 'android_vr', 'tv', 'tv_simply', 'web_embedded', 'web_safari', 'mweb', 'default']) {
      try {
        await tryDownload(url, source, client);
        lastError = null;
        break;
      } catch (error) {
        lastError = error;
        const stderr = String(error?.stderr || '').trim();
        const stdout = String(error?.stdout || '').trim();
        const message = String(error?.message || error);
        failures.push({ client, message: (stderr || stdout || message).slice(0, 1800) });
        console.warn('[YouTube playback] client failed', {
          client,
          videoId: id,
          message: (stderr || stdout || message).slice(0, 1800)
        });
        await fs.rm(source, { force: true }).catch(() => {});
        if (/not made this video available in your country|not available in your country|geo.?restrict|country/i.test(message)) break;
      }
    }

    if (lastError) {
      try {
        await tryPipedDownload(id, source);
        lastError = null;
        console.info('[YouTube playback] primary extractor failed; Piped fallback succeeded', { videoId: id });
      } catch (pipedError) {
        failures.push({ client: 'piped', message: String(pipedError?.message || pipedError).slice(0, 1800) });
        console.warn('[YouTube playback] Piped fallback failed', {
          videoId: id,
          message: String(pipedError?.message || pipedError).slice(0, 1800)
        });
      }
    }

    if (lastError) {
      try {
        await tryInvidiousDownload(id, source);
        lastError = null;
        console.info('[YouTube playback] primary extractor failed; Invidious fallback succeeded', { videoId: id });
      } catch (fallbackError) {
        failures.push({ client: 'invidious', message: String(fallbackError?.message || fallbackError).slice(0, 1800) });
      }
    }

    if (lastError) {
      const details = failures.map(x => x.client + ': ' + x.message).join(' | ').slice(0, 7000);
      if (/not made this video available in your country|not available in your country|geo.?restrict|country/i.test(details))
        throw new Error('YouTube video is not available for playback in Israel');
      if (/sign in to confirm|not a bot|bot check|bot/i.test(details))
        throw new Error('YouTube bot check blocked playback on Render: ' + details);
      throw new Error('YouTube playback failed: ' + details);
    }

    const chunks = await makeChunks(source, chunkDir);
    console.info('[YouTube playback] prepared chunks', { videoId: id, count: chunks.length, chunkSeconds: CHUNK_SECONDS });

    for (let i = 0; i < chunks.length; i++) {
      const remotePath = 'ivr2:/2/youtube/' + id + '-' + String(i + 1).padStart(3, '0') + '.wav';
      const uploadResult = await uploadToYemot(chunks[i], remotePath);
      playbackPaths.push('/2/youtube/' + id + '-' + String(i + 1).padStart(3, '0'));
      console.info('[YouTube playback] uploaded chunk', {
        videoId: id,
        index: i + 1,
        total: chunks.length,
        remotePath,
        responseStatus: uploadResult?.responseStatus || uploadResult?.success || 'unknown'
      });
    }

    return { playbackPaths, chunkCount: playbackPaths.length };
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true }).catch(() => {});
  }
}

export async function downloadAndUploadYouTubeAudio(videoId) {
  const id = String(videoId || '').trim();
  if (activeJobs.has(id)) return activeJobs.get(id);
  const job = buildYouTubePlayback(id).finally(() => activeJobs.delete(id));
  activeJobs.set(id, job);
  return job;
}
