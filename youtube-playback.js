import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import youtubedl from 'youtube-dl-exec';
import ffmpegPath from 'ffmpeg-static';

const YEMOT_UPLOAD_URL = 'https://www.call2all.co.il/ym/api/UploadFile';

function yemotApiKey() {
  const key = String(process.env.YEMOT_API_KEY || '').trim();
  if (!key) throw new Error('YEMOT_API_KEY is missing');
  return key;
}

async function uploadToYemot(filePath, remotePath) {
  const buffer = await fs.readFile(filePath);
  if (buffer.length >= 50 * 1024 * 1024) {
    throw new Error('YouTube audio is too large for Yemot');
  }

  const form = new FormData();
  form.append('token', yemotApiKey());
  form.append('path', remotePath);
  form.append('convertAudio', '1');
  form.append('autoNumbering', 'false');
  form.append('file', new Blob([buffer], { type: 'audio/mpeg' }), path.basename(filePath));

  const response = await fetch(YEMOT_UPLOAD_URL, { method: 'POST', body: form });
  const body = await response.text();

  if (!response.ok) {
    throw new Error('Yemot UploadFile HTTP ' + response.status + ': ' + body.slice(0, 300));
  }

  let result;
  try {
    result = JSON.parse(body);
  } catch {
    throw new Error('Yemot UploadFile returned invalid JSON: ' + body.slice(0, 300));
  }

  if (result.responseStatus && result.responseStatus !== 'OK') {
    throw new Error('Yemot UploadFile failed: ' + (result.message || result.responseStatus));
  }
  if (result.success === false) {
    throw new Error('Yemot UploadFile failed: ' + (result.message || 'unknown error'));
  }
  return result;
}

export async function downloadAndUploadYouTubeAudio(videoId) {
  const id = String(videoId || '').trim();
  if (!/^[A-Za-z0-9_-]{6,20}$/.test(id)) {
    throw new Error('Invalid YouTube video id');
  }

  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'yemot-youtube-'));
  const output = path.join(tempDir, id + '.mp3');
  const remotePath = 'ivr2:/2/youtube/' + id + '.wav';

  try {
    await youtubedl('https://www.youtube.com/watch?v=' + id, {
      output,
      extractAudio: true,
      audioFormat: 'mp3',
      audioQuality: '5',
      noPlaylist: true,
      quiet: true,
      noWarnings: true,
      // Current YouTube servers can reject the default extractor client on hosted IPs.
      // The Android player client is a documented yt-dlp workaround for this failure mode.
      extractorArgs: 'youtube:player_client=android',
      maxFilesize: '49M',
      ...(ffmpegPath ? { ffmpegLocation: ffmpegPath } : {})
    });

    await uploadToYemot(output, remotePath);
    return { remotePath, playbackPath: '/2/youtube/' + id };
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true }).catch(() => {});
  }
}
