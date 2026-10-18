import { chromium } from 'playwright';

const token = process.env.BROWSERLESS_TOKEN;
const extensionName = process.env.BROWSERLESS_EXTENSION_NAME;
const endpoint = process.env.BROWSERLESS_WS_ENDPOINT || 'wss://production-sfo.browserless.io';

if (!token || token.length < 16) {
  console.error('Missing BROWSERLESS_TOKEN (keep it in a local environment variable; never paste it into chat or commit it).');
  process.exit(2);
}
if (!extensionName || !/^[a-zA-Z0-9._ -]{1,100}$/.test(extensionName)) {
  console.error('Set BROWSERLESS_EXTENSION_NAME to the exact extension name uploaded in the Browserless dashboard.');
  process.exit(2);
}

let parsed;
try {
  parsed = new URL(endpoint);
} catch {
  console.error('BROWSERLESS_WS_ENDPOINT is not a valid URL.');
  process.exit(2);
}
if (parsed.protocol !== 'wss:' && !(parsed.protocol === 'ws:' && ['localhost', '127.0.0.1'].includes(parsed.hostname))) {
  console.error('Refusing an insecure remote WebSocket endpoint; use wss://.');
  process.exit(2);
}

parsed.searchParams.set('token', token);
parsed.searchParams.set('timeout', '110000');
parsed.searchParams.set('launch', JSON.stringify({ extensions: [extensionName] }));

let browser;
try {
  browser = await chromium.connectOverCDP(parsed.toString(), { timeout: 25_000 });
  const contexts = browser.contexts();
  if (!contexts.length) throw new Error('browser_context_missing');
  const context = contexts[0];

  const page = await context.newPage();
  await page.goto('https://example.com/', { waitUntil: 'domcontentloaded', timeout: 15_000 });
  const pageTitle = await page.title();
  const heading = (await page.locator('h1').first().textContent({ timeout: 5_000 }))?.trim() || '';

  let extensionTargetSeen = false;
  try {
    const cdp = await browser.newBrowserCDPSession();
    const { targetInfos = [] } = await cdp.send('Target.getTargets');
    extensionTargetSeen = targetInfos.some(target =>
      typeof target.url === 'string' &&
      target.url.startsWith('chrome-extension://') &&
      (target.type === 'service_worker' || target.type === 'background_page' || target.type === 'page')
    );
    await cdp.detach();
  } catch {
    // Do not fail the public-page test if the provider does not expose browser-level target inspection.
  }

  console.log(JSON.stringify({
    browserConnected: true,
    publicPageRead: pageTitle === 'Example Domain' && heading === 'Example Domain',
    pageTitle,
    heading,
    extensionTargetSeen,
    interpretation: extensionTargetSeen
      ? 'An extension target was observed. This does not prove the side panel or Gemini task flow works.'
      : 'Public-page smoke test only. Extension load is unverified; inspect the provider dashboard/logs and perform a manual extension UI test.'
  }, null, 2));

  if (pageTitle !== 'Example Domain' || heading !== 'Example Domain') process.exitCode = 1;
} catch (error) {
  const safeCode = typeof error?.code === 'string' && /^[a-z0-9_-]{1,40}$/i.test(error.code)
    ? error.code
    : 'browserless_smoke_failed';
  console.error(JSON.stringify({ ok: false, error: safeCode }));
  process.exitCode = 1;
} finally {
  if (browser) {
    try { await browser.close(); } catch {}
  }
}
