import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import youtubedl from 'youtube-dl-exec';

const YTDLP_PLUGIN_ROOT = path.join(
  process.cwd(),
  'node_modules',
  'youtube-dl-exec',
  'bin',
  'yt-dlp-plugins',
  'bgutil-ytdlp-pot-provider'
);

const PREFERRED_LANGS = ['he', 'iw', 'en'];

// The PO-token plugin only helps when its provider server is actually running
// (YTDLP_POT_PROVIDER_URL). Loading it without one crashes yt-dlp at start-up,
// so by default yt-dlp runs without plugins.
const POT_PROVIDER_URL = String(process.env.YTDLP_POT_PROVIDER_URL || '').trim();
function extractorArgs(client) {
  return [
    'youtube:player_client=' + client,
    ...(POT_PROVIDER_URL ? ['youtubepot-bgutilhttp:base_url=' + POT_PROVIDER_URL, 'pot_trace=true'] : [])
  ].join(';');
}
function pluginOptions() {
  return POT_PROVIDER_URL ? { pluginDirs: YTDLP_PLUGIN_ROOT } : { noPluginDirs: true };
}

function cleanCaptionText(raw) {
  return String(raw || '')
    .replace(/\r/g, '')
    .replace(/<c[^>]*>/g, '')
    .replace(/<\/c>/g, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\u00a0/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function parseCaptionFile(raw) {
  const blocks = String(raw || '').replace(/^\uFEFF/, '').split(/\n\s*\n+/);
  const lines = [];
  for (const block of blocks) {
    const part = block.split(/\n/).map(x => x.trim()).filter(Boolean);
    if (!part.length) continue;
    if (/^(WEBVTT|Kind:|Language:)/i.test(part[0])) continue;
    const textLines = part.filter(line =>
      !/^\d+$/.test(line) &&
      !/-->/.test(line) &&
      !/^NOTE($|\s)/i.test(line)
    );
    const text = cleanCaptionText(textLines.join(' '));
    if (text) lines.push(text);
  }
  const deduped = [];
  for (const line of lines) {
    if (deduped[deduped.length - 1] !== line) deduped.push(line);
  }
  return deduped.join(' ').replace(/\s+/g, ' ').trim();
}

function chooseLanguage(info) {
  const available = [
    ...Object.keys(info?.subtitles || {}),
    ...Object.keys(info?.automatic_captions || {})
  ].filter(Boolean);
  if (!available.length) return null;

  const normalized = available.map(language => ({
    language,
    lower: language.toLowerCase()
  }));

  for (const wanted of PREFERRED_LANGS) {
    const found = normalized.find(x =>
      x.lower === wanted || x.lower.startsWith(wanted + '-')
    );
    if (found) return found.language;
  }

  const videoLanguage = String(info?.language || '').toLowerCase();
  if (videoLanguage) {
    const found = normalized.find(x =>
      x.lower === videoLanguage || x.lower.startsWith(videoLanguage + '-')
    );
    if (found) return found.language;
  }

  return available[0];
}

function parseDumpedJson(value) {
  if (value && typeof value === 'object') return value;
  const text = String(value || '').trim();
  if (!text) throw new Error('yt-dlp returned empty video metadata');
  return JSON.parse(text);
}

async function getInfo(url, client) {
  return parseDumpedJson(await youtubedl(url, {
    dumpSingleJson: true,
    skipDownload: true,
    quiet: true,
    jsRuntimes: 'node',
    ...pluginOptions(),
    extractorArgs: extractorArgs(client)
  }));
}

async function downloadCaption(url, tempDir, language, client) {
  const outputTemplate = path.join(tempDir, 'caption.%(ext)s');
  await youtubedl(url, {
    skipDownload: true,
    writeSubs: true,
    writeAutoSubs: true,
    subLangs: language,
    subFormat: 'vtt/best',
    noPlaylist: true,
    quiet: false,
    verbose: true,
    jsRuntimes: 'node',
    ...pluginOptions(),
    extractorArgs: extractorArgs(client),
    output: outputTemplate
  });

  const files = await fs.readdir(tempDir);
  const captionFile = files.find(file =>
    /^caption(?:\.[^.]+)?\.(vtt|srt|srv3|srv2|ttml)$/i.test(file)
  );
  if (!captionFile) {
    throw new Error('yt-dlp did not produce a caption file for language ' + language);
  }
  return fs.readFile(path.join(tempDir, captionFile), 'utf8');
}

function chunkText(text, maxLength = 1400) {
  const normalized = String(text || '').replace(/\s+/g, ' ').trim();
  if (!normalized) return [];

  const chunks = [];
  let rest = normalized;
  while (rest.length > maxLength) {
    let cut = rest.lastIndexOf('. ', maxLength);
    if (cut < Math.floor(maxLength * 0.55)) cut = rest.lastIndexOf(' ', maxLength);
    if (cut < 1) cut = maxLength;
    const take = rest[cut] === '.' ? cut + 1 : cut;
    chunks.push(rest.slice(0, take).trim());
    rest = rest.slice(take).trim();
  }
  if (rest) chunks.push(rest);
  return chunks;
}

// YouTube answers this server's address with "Sign in to confirm you're not a
// bot". After that, caption downloads are skipped for a while instead of
// spending three yt-dlp runs per question; Gemini watches the video meanwhile.
let botBlockedUntil = 0;
const BOT_BLOCK_REST_MS = Number(process.env.YOUTUBE_CAPTIONS_BOT_REST_MS || 6 * 60 * 60 * 1000);

export async function getYouTubeTranscript(videoId) {
  const id = String(videoId || '').trim();
  if (!/^[A-Za-z0-9_-]{6,20}$/.test(id)) throw new Error('Invalid YouTube video id');
  if (Date.now() < botBlockedUntil) throw new Error('YouTube captions resting after a bot check from this server');

  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'yemot-youtube-caption-'));
  const url = 'https://www.youtube.com/watch?v=' + id;

  try {
    let lastError;
    for (const client of ['web_safari', 'mweb', 'default']) {
      try {
        console.info('[YouTube captions] inspecting tracks', { videoId: id, client });
        const info = await getInfo(url, client);
        const language = chooseLanguage(info);

        if (!language) {
          throw new Error('YouTube video has no available subtitle or automatic-caption track');
        }

        console.info('[YouTube captions] selected track', {
          videoId: id,
          client,
          language,
          manual: Boolean(info?.subtitles?.[language]),
          automatic: Boolean(info?.automatic_captions?.[language])
        });

        await fs.rm(tempDir, { recursive: true, force: true });
        await fs.mkdir(tempDir, { recursive: true });

        const raw = await downloadCaption(url, tempDir, language, client);
        const text = parseCaptionFile(raw);
        if (!text) throw new Error('Caption file was downloaded but contained no readable text');

        const chunks = chunkText(text);
        if (!chunks.length) throw new Error('Caption text was empty after parsing');

        return { language, text, chunks };
      } catch (error) {
        lastError = error;
        if (/confirm you.?re not a bot|Sign in to confirm/i.test(String(error?.message || error))) {
          botBlockedUntil = Date.now() + BOT_BLOCK_REST_MS;
          console.warn('[YouTube captions] blocked by YouTube bot check; resting', { hours: BOT_BLOCK_REST_MS / 3600000 });
          throw error;
        }
        console.warn('[YouTube captions] client failed', {
          videoId: id,
          client,
          message: String(error?.message || error).slice(0, 1600)
        });
        await fs.rm(tempDir, { recursive: true, force: true }).catch(() => {});
        await fs.mkdir(tempDir, { recursive: true });
        if (/not made this video available in your country|not available in your country|geo.?restrict|country/i.test(String(error?.message || error))) break;
      }
    }
    throw lastError || new Error('YouTube captions unavailable');
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true }).catch(() => {});
  }
}
