// One place that decides which ffmpeg every module runs.
// ffmpeg-static ships its binary through an install script; where that script
// was skipped (CI uses --ignore-scripts) or its download failed, the path it
// returns points at a file that does not exist and every conversion fails.
// Then fall back to an ffmpeg on the system PATH (installed on the VPS and in
// CI). FFMPEG_BIN still overrides everything (ffmpeg-static's own setting).
import { existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import staticPath from 'ffmpeg-static';

function resolveFfmpeg() {
  if (process.env.FFMPEG_BIN) return process.env.FFMPEG_BIN;
  if (staticPath && existsSync(staticPath)) return staticPath;
  for (const candidate of ['ffmpeg', '/usr/bin/ffmpeg', '/usr/local/bin/ffmpeg']) {
    try { execFileSync(candidate, ['-version'], { stdio: 'ignore', timeout: 5000 }); return candidate; } catch {}
  }
  return staticPath || null;
}

const ffmpegPath = resolveFfmpeg();
export default ffmpegPath;
