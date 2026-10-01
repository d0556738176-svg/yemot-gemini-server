import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import youtubedl from 'youtube-dl-exec';
import ffmpegPath from 'ffmpeg-static';

const YEMOT_UPLOAD_URL = 'https://www.call2all.co.il/ym/api/UploadFile';
const YTDLP_PLUGIN_ROOT = path.join(process.cwd(), 'node_modules', 'youtube-dl-exec', 'bin', 'yt-dlp-plugins', 'bgutil-ytdlp-pot-provider');
const activeJobs = new Map();
const CHUNK_SECONDS = 120;
const MAX_SOURCE_BYTES = 180 * 1024 * 1024;

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
  const extractorArgs = [
    'youtube:player_client=' + client,
    'youtube:fetch_pot=always',
    'youtube:pot_trace=true',
    'youtubepot-bgutilhttp:base_url=http://127.0.0.1:4416;disable_innertube=1'
  ].join(';');

  await youtubedl(url, {
    output,
    extractAudio: true,
    audioFormat: 'mp3',
    audioQuality: '7',
    format: 'bestaudio/best',
    noPlaylist: true,
    quiet: false,
    verbose: true,
    jsRuntimes: 'node',
    pluginDirs: YTDLP_PLUGIN_ROOT,
    extractorArgs,
    maxFilesize: '180M',
    ...(ffmpegPath ? { ffmpegLocation: ffmpegPath } : {})
  });

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
    '-vn', '-ac', '1', '-ar', '24000',
    '-c:a', 'pcm_s16le', '-ar', '8000', '-ac', '1',
    '-f', 'segment', '-segment_time', String(CHUNK_SECONDS), '-reset_timestamps', '1',
    pattern
  ]);
  const names = (await fs.readdir(chunkDir)).filter(n => /^chunk-\d{3}\.wav$/.test(n)).sort();
  if (!names.length) throw new Error('ffmpeg produced no audio chunks');
  return names.map(n => path.join(chunkDir, n));
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
    for (const client of ['web_safari', 'mweb', 'default']) {
      try {
        await tryDownload(url, source, client);
        lastError = null;
        break;
      } catch (error) {
        lastError = error;
        failures.push({ client, message: String(error?.message || error).slice(0, 1600) });
        console.warn('[YouTube playback] client failed', { client, videoId: id, message: String(error?.message || error).slice(0, 1600) });
        await fs.rm(source, { force: true }).catch(() => {});
        if (/not made this video available in your country|not available in your country|geo.?restrict|country/i.test(String(error?.message || error))) break;
      }
    }

    if (lastError) {
      const message = String(lastError?.message || lastError);
      if (/not made this video available in your country|not available in your country|geo.?restrict|country/i.test(message))
        throw new Error('YouTube video is not available for playback in Israel');
      if (/sign in to confirm|not a bot|bot/i.test(message))
        throw new Error('YouTube bot check blocked playback on Render');
      throw new Error('YouTube playback failed: ' + failures.map(x => x.client + ': ' + x.message).join(' | ').slice(0, 5000));
    }

    const chunks = await makeChunks(source, chunkDir);
    console.info('[YouTube playback] prepared chunks', { videoId: id, count: chunks.length, chunkSeconds: CHUNK_SECONDS });

    for (let i = 0; i < chunks.length; i++) {
      const remotePath = 'ivr2:/2/youtube/' + id + '-' + String(i + 1).padStart(3, '0') + '.wav';
      await uploadToYemot(chunks[i], remotePath);
      playbackPaths.push('/2/youtube/' + id + '-' + String(i + 1).padStart(3, '0'));
      console.info('[YouTube playback] uploaded chunk', { videoId: id, index: i + 1, total: chunks.length, remotePath });
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
