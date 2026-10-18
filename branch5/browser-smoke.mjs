import { chromium } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';

const extensionDir = process.env.BRIDGE_EXTENSION_DIR;
if (!extensionDir || !fs.existsSync(path.join(extensionDir, 'manifest.json'))) {
  console.error('Set BRIDGE_EXTENSION_DIR to the extracted extension directory containing manifest.json.');
  process.exit(2);
}

const absoluteExtensionDir = path.resolve(extensionDir);
const profileDir = process.env.BRIDGE_PROFILE_DIR
  ? path.resolve(process.env.BRIDGE_PROFILE_DIR)
  : '';
const headless = process.env.BRIDGE_HEADLESS !== 'false';

if (profileDir) {
  fs.mkdirSync(profileDir, { recursive: true, mode: 0o700 });
  try { fs.chmodSync(profileDir, 0o700); } catch {}
  console.log('Using a dedicated persistent browser profile. It may contain sign-in cookies; do not copy or commit it.');
} else {
  console.log('Using a temporary browser profile. Sign-in state will not persist after this run.');
}

let context;
try {
  context = await chromium.launchPersistentContext(profileDir, {
    headless,
    channel: 'chromium',
    args: [
      `--disable-extensions-except=${absoluteExtensionDir}`,
      `--load-extension=${absoluteExtensionDir}`
    ]
  });

  let workers = context.serviceWorkers();
  if (!workers.length) {
    try {
      await context.waitForEvent('serviceworker', { timeout: 10000 });
    } catch {}
    workers = context.serviceWorkers();
  }
  const extensionWorkers = workers
    .map(worker => {
      try {
        const url = new URL(worker.url());
        return url.protocol === 'chrome-extension:' ? url.host : null;
      } catch { return null; }
    })
    .filter(Boolean);

  const page = await context.newPage();
  const response = await page.goto('https://gemini.google.com/app', {
    waitUntil: 'domcontentloaded',
    timeout: 20000
  });
  const title = await page.title().catch(() => '');
  const currentUrl = new URL(page.url());
  const composerVisible = await page.locator('rich-textarea, [contenteditable="true"], textarea').first()
    .isVisible({ timeout: 3000 }).catch(() => false);
  const passwordFieldVisible = await page.locator('input[type="password"]').first()
    .isVisible({ timeout: 1000 }).catch(() => false);

  console.log(JSON.stringify({
    chromiumLaunched: true,
    extensionDirectoryFound: true,
    extensionWorkerObserved: extensionWorkers.length > 0,
    extensionWorkerCount: extensionWorkers.length,
    geminiNavigationStatus: response?.status() ?? null,
    pageTitlePresent: Boolean(title),
    currentHost: currentUrl.host,
    composerVisible,
    passwordFieldVisible,
    loginState: composerVisible ? 'composer_detected_needs_manual_confirmation' :
      passwordFieldVisible ? 'login_form_detected' : 'unknown',
    livePromptSent: false,
    sensitiveControlsClicked: false,
    note: 'Smoke test only. It never types credentials, submits a login, or sends a Gemini prompt.'
  }, null, 2));

  if (!extensionWorkers.length) process.exitCode = 1;
} catch (error) {
  console.error('Browser smoke test failed. No Gemini prompt was sent.');
  console.error(error?.name || 'Error', error?.message || 'unknown error');
  process.exitCode = 1;
} finally {
  await context?.close().catch(() => {});
}
