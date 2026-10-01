import fs from 'node:fs/promises';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const root = process.cwd();
const providerRoot = path.join(root, '.bgutil-ytdlp-pot-provider');
const serverDir = path.join(providerRoot, 'server');
const pluginRoot = path.join(root, 'node_modules', 'youtube-dl-exec', 'bin', 'yt-dlp-plugins', 'bgutil-ytdlp-pot-provider');
const pluginTarget = path.join(pluginRoot, 'yt_dlp_plugins');

async function exists(p) {
  try { await fs.access(p); return true; } catch { return false; }
}

await fs.rm(providerRoot, { recursive: true, force: true });

if (!(await exists(path.join(serverDir, 'build', 'main.js')))) {
  execFileSync('git', [
    'clone', '--depth', '1', '--branch', '2.0.0',
    'https://github.com/Brainicism/bgutil-ytdlp-pot-provider.git',
    providerRoot
  ], { stdio: 'inherit' });

  execFileSync('npm', ['ci'], { cwd: serverDir, stdio: 'inherit' });
  execFileSync('npx', ['tsc'], { cwd: serverDir, stdio: 'inherit' });
}

await fs.rm(pluginRoot, { recursive: true, force: true });
await fs.mkdir(pluginTarget, { recursive: true });
await fs.cp(path.join(providerRoot, 'plugin', 'yt_dlp_plugins'), pluginTarget, { recursive: true });

for (const file of [path.join(serverDir, 'build', 'main.js'), path.join(serverDir, 'build', 'generate_once.js')]) {
  if (!(await exists(file))) throw new Error('[YouTube POT] missing compiled provider file: ' + file);
}
console.info('[YouTube POT] provider and plugin ready', { version: '2.0.0' });
