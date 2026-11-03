import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { preparePhoneAudio, runFfmpeg, parseIntegratedLufs, gainFor, phoneAudioSettings } from './youtube-phone-audio.js';

async function measure(file) {
  const report = await runFfmpeg(['-hide_banner', '-nostats', '-i', file, '-af', 'ebur128=peak=true', '-f', 'null', '-'], { collect: true });
  const lufs = parseIntegratedLufs(report);
  const peaks = [...report.matchAll(/Peak:\s+(-?[\d.]+|-inf) dBFS/g)];
  const buf = await fs.readFile(file);
  let clipped = 0, max = 0;
  for (let i = 44; i + 1 < buf.length; i += 2) { const v = Math.abs(buf.readInt16LE(i)); if (v > max) max = v; if (v >= 32600) clipped++; }
  return { lufs, truePeak: Number(peaks[peaks.length - 1][1]), samplePeakDb: 20 * Math.log10(Math.max(1, max) / 32768), clipped };
}

async function source(dir, name, filter) {
  const file = path.join(dir, name + '.wav');
  await runFfmpeg(['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'sine=f=220:d=20',
    '-f', 'lavfi', '-i', 'sine=f=55:d=20', '-f', 'lavfi', '-i', 'anoisesrc=d=20:c=pink:a=0.3',
    '-filter_complex', '[0][1][2]amix=3:normalize=0,' + filter + ',aformat=channel_layouts=stereo', '-ar', '44100', file]);
  return file;
}

test('loud and quiet songs both come out at a moderate phone level with no clipping', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'phone-audio-'));
  try {
    // A brick-walled master hitting full scale, and a quiet upload ~24dB lower.
    const loud = await source(dir, 'loud', 'volume=6dB,alimiter=limit=0.99:level=disabled');
    const quiet = await source(dir, 'quiet', 'volume=-18dB');
    const results = {};
    for (const [name, file] of Object.entries({ loud, quiet })) {
      const out = path.join(dir, name + '-phone.wav');
      const info = await preparePhoneAudio(file, out);
      const m = await measure(out);
      results[name] = m;
      assert.ok(m.lufs > -23 && m.lufs < -16, name + ' loudness ' + m.lufs);
      assert.ok(m.samplePeakDb <= -4, name + ' peak ' + m.samplePeakDb);
      assert.equal(m.clipped, 0, name + ' must not clip');
      assert.ok(Math.abs(info.durationSec - 20) < 0.5, 'duration kept');
    }
    assert.ok(Math.abs(results.loud.lufs - results.quiet.lufs) < 2.5, 'songs end up at the same level');
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
});

test('gain is bounded and silence is never amplified', () => {
  const s = phoneAudioSettings({});
  assert.equal(gainFor(-Infinity, s), 0);
  assert.equal(gainFor(-90, s), 0);
  assert.equal(gainFor(-60, s), s.maxBoostDb);
  assert.equal(gainFor(5, s), -s.maxCutDb);
});
