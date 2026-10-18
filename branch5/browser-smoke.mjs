import { chromium } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';

const extensionDir = process.env.BRIDGE_EXTENSION_DIR;
if (!extensionDir || !fs.existsSync(path.join(extensionDir, 'manifest.json'))) {
  console.error('Set BRIDGE_EXTENSION_DIR to the extracted extension directory containing manifest.json.');
  process.exit(2);
}

const absoluteExtensionDir = path.resolve(extensionDir);
let context;
try {
  context = await chromium.launchPersistentContext('', {
    headless: true,
    channel: 'chromium',
    args: [
      `--disable-extensions-except=${absoluteExtensionDir}`,
      `--load-extension=${absoluteExtensionDir}`
    ]
  });
  const page = await context.newPage();
  const response = await page.goto('https://gemini.google.com/app', {
    waitUntil: 'domcontentloaded',
    timeout: 20000
  });
  const title = await page.title().catch(() => '');
  const extensionWorkers = context.serviceWorkers().map(worker => {
    try { return new URL(worker.url()).host; } catch { return 'unknown'; }
  });
  console.log(JSON.stringify({
    chromiumLaunched: true,
    extensionDirectoryFound: true,
    geminiNavigationStatus: response?.status() ?? null,
    pageTitlePresent: Boolean(title),
    extensionServiceWorkerObserved: extensionWorkers.length > 0,
    extensionWorkerHosts: extensionWorkers,
    liveLoginVerified: false,
    livePromptSent: false,
    liveGeminiSelectorsVerified: false,
    note: 'Smoke test only. Does not sign in or send any prompt.'
  }, null, 2));
} catch (error) {
  console.error('Browser smoke test failed. No Gemini prompt was sent.');
  console.error(error?.name || 'Error', error?.message || 'unknown error');
  process.exitCode = 1;
} finally {
  await context?.close().catch(() => {});
}
