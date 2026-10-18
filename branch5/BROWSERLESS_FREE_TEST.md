# Branch 5 — Browserless isolated smoke test

**Purpose:** verify whether the Browserless cloud browser can start with the uploaded Gemini Browser Bridge extension and read a harmless public page. This is a test harness only; it does not connect to Yemot, Render, or the root application.

## Before starting

1. Create a Browserless account yourself and confirm the dashboard shows the **Free $0/month** tier and its current limits. Do not enter payment details or enable paid overages.
2. Upload the user-owned Gemini Browser Bridge 0.2.2 ZIP in the Browserless extension dashboard. Give it a simple name and copy the exact name.
3. Create/copy an API token. Keep it secret. Do not commit it, paste it into chat, put it in a URL that you share, or include it in screenshots.
4. The free plan's published limit is 1,000 units/month and up to two concurrent browsers, with a maximum two-minute session. Check the dashboard again before testing because plan terms can change.

## Run locally

Requires Node.js 22+ and the existing branch5 Playwright dependency. From the repository root:

```sh
cd branch5
npm install
```

Set these variables in your local terminal (do not put the token into source code):

PowerShell:
```powershell
$env:BROWSERLESS_TOKEN = "PASTE_TOKEN_IN_THIS_LOCAL_TERMINAL_ONLY"
$env:BROWSERLESS_EXTENSION_NAME = "EXACT_EXTENSION_NAME_FROM_DASHBOARD"
node .\browserless-smoke.mjs
```

macOS/Linux:
```sh
export BROWSERLESS_TOKEN='TOKEN_IN_LOCAL_ENVIRONMENT'
export BROWSERLESS_EXTENSION_NAME='EXACT_EXTENSION_NAME_FROM_DASHBOARD'
node ./browserless-smoke.mjs
```

Optional: set `BROWSERLESS_WS_ENDPOINT` to the exact WSS endpoint for the region shown in your Browserless dashboard. The default is `wss://production-sfo.browserless.io`.

## What the test means

- `publicPageRead: true`: the cloud browser connected and read the title and heading from `https://example.com`.
- `extensionTargetSeen: true`: Chrome DevTools Protocol exposed an extension target. This is evidence that an extension target started, **not proof** that the side panel or Gemini Browser Bridge workflow works.
- `extensionTargetSeen: false`: inconclusive for extension loading; the provider may not expose a sleeping service worker as a target. Check the uploaded extension name, Browserless session logs and extension list.
- No credentials are entered and no Gemini prompt is sent by this script.

## Acceptance gates after this smoke test

1. Confirm the extension appears in the remote browser's extension diagnostics.
2. Confirm the extension's side panel can actually be opened in the cloud session.
3. Sign into Gemini manually in a secured interactive session, using a dedicated test account. Do not bypass MFA/CAPTCHA.
4. Only after steps 1–3 work, run one harmless read-only task and independently verify the returned text.
5. Do not enable the worker queue, merge any PR, deploy, or connect Yemot until the extension-to-worker adapter exists, security-reviewed tests pass, and the user separately approves.

## Isolation

This test only uses files under `branch5/`. It does not change root `server.js`, root `package.json`, root `render.yaml`, branches 1–4, live Render, or Yemot configuration. Browserless API usage is external to GitHub and is subject to its own limits.
