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

  const url = new URL(YEMOT_UPLOAD_URL);
  url.searchParams.set('token', yemotApiKey());
  url.searchParams.set('path', remotePath);
  url.searchParams.set('convertAudio', '1');
  url.searchParams.set('autoNumbering', 'false');

  const form = new FormData();
  form.append('file', new Blob([buffer], { type: 'audio/mpeg' }), path.basename(filePath));

  const response = await fetch(url, { method: 'POST', body: form });
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

async function tryDownload(url, output, client) {
  console.info('[YouTube playback] trying client', {
    client,
    videoId: path.basename(output, '.mp3')
  });

  await youtubedl(url, {
    output,
    extractAudio: true,
    audioFormat: 'mp3',
    audioQuality: '5',
    noPlaylist: true,
    quiet: true,
    noWarnings: false,
    extractorArgs: 'youtube:player_client=' + client,
    maxFilesize: '49M',
    ...(ffmpegPath ? { ffmpegLocation: ffmpegPath } : {})
  });

  const stat = await fs.stat(output);
  if (!stat.size) throw new Error('yt-dlp produced an empty audio file');

  console.info('[YouTube playback] downloaded', {
    client,
    videoId: path.basename(output, '.mp3'),
    bytes: stat.size
  });
}

export async function downloadAndUploadYouTubeAudio(videoId) {
  const id = String(videoId || '').trim();
  if (!/^[A-Za-z0-9_-]{6,20}$/.test(id)) {
    throw new Error('Invalid YouTube video id');
  }

  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'yemot-youtube-'));
  const output = path.join(tempDir, id + '.mp3');
  const remotePath = 'ivr2:/2/youtube/' + id + '.wav';
  const url = 'https://www.youtube.com/watch?v=' + id;

  try {
    let lastError;

    // Current YouTube enforcement is blocking some server IPs with the
    // regular Android client. Try clients that currently avoid PO tokens
    // before falling back to Android. android_vr can provide a muxed stream
    // that ffmpeg can extract to audio even when other clients are blocked.
    for (const client of ['tv', 'android_vr', 'web_embedded', 'android']) {
      try {
        await tryDownload(url, output, client);
        lastError = null;
        break;
      } catch (error) {
        lastError = error;
        console.warn('[YouTube playback] client failed', {
          client,
          videoId: id,
          message: String(error?.message || error).slice(0, 800)
        });
        await fs.rm(output, { force: true }).catch(() => {});
      }
    }

    if (lastError) {
      const message = String(lastError?.message || lastError);
      if (/sign in to confirm|not a bot|bot/i.test(message)) {
        throw new Error('YouTube blocked the Render server IP with a bot check after all playback clients failed');
      }
      throw lastError;
    }

    console.info('[YouTube playback] uploading to Yemot', {
      videoId: id,
      remotePath
    });

    const uploadResult = await uploadToYemot(output, remotePath);
    console.info('[YouTube playback] upload complete', {
      videoId: id,
      remotePath,
      size: uploadResult.size ?? null,
      duration: uploadResult.duration ?? null
    });

    // yemot-router2 expects a file path without the extension.
    return { remotePath, playbackPath: '/2/youtube/' + id };
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true }).catch(() => {});
  }
}
