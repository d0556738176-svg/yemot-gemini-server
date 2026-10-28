// Branch 4 isolated engine self-test.
//
// Runs once at boot only when BRANCH4_ENGINE_SELFTEST_ID is set. It asks the
// configured music engine (ACE-Step Space by default) to generate one short
// song from fixed Hebrew lyrics, then reports — reachable? generated? audio
// bytes? content type? how long it took? It also runs the production FFmpeg
// conversion to the Yemot format so we know the output is usable.
//
// It needs NO Yemot routing and NO PUBLIC_BASE_URL, so it can never touch the
// live phone line. Logs statuses, sizes and durations only — no tokens.
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import ffmpegPath from 'ffmpeg-static';
import { generateWithHuggingFaceSpace } from './song-generator-hf-space.js';
import { generateWithFalAceStep, isFalConfigured } from './song-engine-fal.js';

const TAG = '[BRANCH4_ENGINE_SELFTEST]';
// Short, clearly original Hebrew test lyrics — enough to hear vocals.
const TEST_LYRICS = 'שלום שלום בוקר טוב\nהשמש זורחת בשמים\nיום חדש מתחיל עכשיו\nנשיר יחד שיר נעים';
const TEST_PROMPT = 'calm acoustic hebrew song, gentle male vocal, simple melody';

function ffmpegToYemotWav(input, output, maxMs = 60000) {
  return new Promise((resolve, reject) => {
    if (!ffmpegPath) return reject(new Error('ffmpeg-static unavailable'));
    const child = spawn(ffmpegPath, ['-hide_banner', '-loglevel', 'error', '-y', '-i', input,
      '-vn', '-ar', '8000', '-ac', '1', '-c:a', 'pcm_s16le', '-t', '60', output], { stdio: ['ignore', 'ignore', 'pipe'] });
    let err = '';
    const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error('ffmpeg timed out')); }, maxMs);
    child.stderr.on('data', d => { err += d; });
    child.on('error', e => { clearTimeout(timer); reject(e); });
    child.on('close', c => { clearTimeout(timer); c === 0 ? resolve() : reject(new Error('ffmpeg ' + c + ': ' + err.slice(-200))); });
  });
}

async function wavDurationSec(file) {
  const b = await fs.readFile(file);
  if (b.length < 44 || b.subarray(0, 4).toString() !== 'RIFF') throw new Error('not a WAV');
  const rate = b.readUInt32LE(24), channels = b.readUInt16LE(22), bits = b.readUInt16LE(34);
  return { bytes: b.length, durationSec: +((b.length - 44) / (rate * channels * bits / 8)).toFixed(2), rate, channels, bits };
}

export async function runBranch4EngineSelfTest(env = process.env) {
  const runId = String(env.BRANCH4_ENGINE_SELFTEST_ID || '').replace(/[^A-Za-z0-9_-]/g, '').slice(0, 24);
  if (!runId) return;
  const useFal = isFalConfigured(env);
  const engine = useFal ? 'fal.ai ace-step' : String(env.HF_MUSIC_SPACE_URL || 'default ace-step space');
  console.info(TAG, 'start', { runId, engine, useFal, durationSec: Number(env.BRANCH4_SELFTEST_DURATION || 40) });

  const spec = {
    lyrics: TEST_LYRICS,
    musicPrompt: TEST_PROMPT,
    language: 'he',
    durationSeconds: Math.max(30, Math.min(120, Number(env.BRANCH4_SELFTEST_DURATION || 40)))
  };

  const started = Date.now();
  let result;
  try {
    result = useFal ? await generateWithFalAceStep(spec, env) : await generateWithHuggingFaceSpace(spec);
  } catch (error) {
    console.warn(TAG, 'generation failed', {
      ms: Date.now() - started,
      status: Number(error?.status || 0) || null,
      message: String(error?.message || error).slice(0, 200)
    });
    console.info(TAG, 'summary', JSON.stringify({ reachable: 'see message', generated: false, runId }));
    return;
  }

  const genMs = Date.now() - started;
  const audioBytes = result?.audio?.length || 0;
  console.info(TAG, 'generated', { ms: genMs, provider: result.provider, model: result.model, contentType: result.contentType, audioBytes });

  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'b4eng-'));
  try {
    const ext = /mpeg|mp3/.test(result.contentType) ? 'mp3' : /wav/.test(result.contentType) ? 'wav' : /mp4|m4a|aac/.test(result.contentType) ? 'm4a' : 'bin';
    const src = path.join(temp, 'song.' + ext);
    await fs.writeFile(src, result.audio);
    const wav = path.join(temp, 'song.wav');
    const c0 = Date.now();
    await ffmpegToYemotWav(src, wav);
    const facts = await wavDurationSec(wav);
    console.info(TAG, 'converted to Yemot wav', { convertMs: Date.now() - c0, ...facts });
    console.info(TAG, 'summary', JSON.stringify({
      reachable: true, generated: true, audioBytes, genMs,
      wavSeconds: facts.durationSec, wavRate: facts.rate, wavChannels: facts.channels, runId
    }));
  } catch (e) {
    console.warn(TAG, 'conversion failed', { message: String(e?.message || e).slice(0, 200) });
    console.info(TAG, 'summary', JSON.stringify({ reachable: true, generated: true, converted: false, audioBytes, genMs, runId }));
  } finally {
    await fs.rm(temp, { recursive: true, force: true }).catch(() => {});
  }
}
