import { spawn } from 'node:child_process';
import path from 'node:path';

const provider = spawn(
  process.execPath,
  [path.join(process.cwd(), '.bgutil-ytdlp-pot-provider', 'server', 'build', 'main.js'), '--host', '127.0.0.1', '--port', '4416'],
  { stdio: 'inherit' }
);

provider.on('exit', (code, signal) => {
  console.error('[YouTube POT] provider exited', { code, signal });
});

async function waitForProvider() {
  const deadline = Date.now() + 20000;
  while (Date.now() < deadline) {
    try {
      const response = await fetch('http://127.0.0.1:4416/ping');
      if (response.ok) {
        console.info('[YouTube POT] provider is ready');
        return;
      }
    } catch {}
    await new Promise(resolve => setTimeout(resolve, 250));
  }
  throw new Error('[YouTube POT] provider did not become ready within 20 seconds');
}

await waitForProvider();

const server = spawn(process.execPath, [path.join(process.cwd(), 'server.js')], {
  stdio: 'inherit',
  env: process.env
});

const shutdown = (signal) => {
  provider.kill(signal);
  server.kill(signal);
};

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

server.on('exit', (code, signal) => {
  if (provider.exitCode === null) provider.kill('SIGTERM');
  process.exit(code ?? (signal ? 1 : 0));
});
