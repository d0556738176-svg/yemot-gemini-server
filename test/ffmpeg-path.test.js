import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import ffmpegPath from '../ffmpeg-path.js';

test('an ffmpeg that really runs is found even when ffmpeg-static has no binary', () => {
  assert.ok(ffmpegPath, 'no ffmpeg found');
  assert.match(execFileSync(ffmpegPath, ['-version']).toString(), /ffmpeg version/);
});
