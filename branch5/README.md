# Branch 5 — Gemini Browser Bridge cloud PoC (isolated)

**Status: scaffold only; not production-ready, not deployed, not connected to Yemot.**

This directory is deliberately independent. It does not import the root `server.js`, does not read Yemot management credentials, does not call Yemot APIs, and does not edit the root `render.yaml`.

## What was checked from Gemini Browser Bridge 0.2.2

The supplied package is a Manifest V3 Chrome extension. Its manifest declares a background service worker (`background.js`), a side panel (`panel.html`), content scripts on `https://gemini.google.com/*`, and optional broad HTTP/HTTPS host permissions. It does not expose a server API endpoint or include a Gemini API key in the manifest. The extension itself still relies on an authenticated Gemini web tab and DOM selectors that may change.

Run a static check against the extracted, user-supplied extension directory:

```sh
cd branch5
BRIDGE_EXTENSION_DIR=/absolute/path/to/Gemini-Browser-Bridge npm run extension:check
```

This verifies the manifest version and expected files only; it is not proof that the extension can control a live Gemini session.

## Browser smoke test

Requires Node.js 22+, package install, and the Playwright-bundled Chromium:

```sh
cd branch5
npm install
npx playwright install chromium
BRIDGE_EXTENSION_DIR=/absolute/path/to/Gemini-Browser-Bridge npm run browser:smoke
```

The smoke test attempts to launch Chromium with the extension, wait for its service worker, open Gemini, and report only coarse UI indicators. It never types credentials, submits a login, clicks sensitive controls, or sends a Gemini prompt.

By default it uses a temporary profile, so sign-in will not persist. To use a dedicated persistent profile in a secured private test machine, set `BRIDGE_PROFILE_DIR` to a dedicated directory with restricted access. The script applies owner-only directory permissions where supported. The profile may contain authentication cookies and must be treated as a secret: never commit it, upload it to GitHub, or send it in chat. Do not use your everyday Chrome profile.

## Manual sign-in requirement — not yet solved for cloud

A first-time Google sign-in can require an interactive browser, MFA, CAPTCHA, or account recovery. This code does not automate or bypass those checks. A secure cloud sign-in requires an independently secured interactive browser session (for example, a private remote desktop/tunnel with authentication), a dedicated test account, restricted persistent storage, and a documented session-expiry/re-authentication procedure. No such remote desktop or cloud browser has been deployed by this PR, and no Google account is signed in here. To continue, a separate cloud VM/container with an authenticated, private remote desktop or an SSH-tunneled browser must be provisioned, then a human must sign in manually using a dedicated test account. The access channel and persistent profile storage must be secured before the login is attempted.

Do not paste passwords, one-time codes, cookies, or browser storage into GitHub, Render environment variables, or this chat. If the provider's security checks cannot be completed manually through a secured interactive session, stop.

## Isolated HTTP service

Set a random secret of at least 32 characters, then start:

```sh
export BRANCH5_TOKEN="$(node -e "console.log(require('node:crypto').randomBytes(32).toString('hex'))")"
npm start
```

Health check:
```sh
curl http://localhost:3005/health
```

Authenticated status:
```sh
curl -X POST http://localhost:3005/api/status \
  -H "Authorization: Bearer $BRANCH5_TOKEN"
```

Task requests require the same Bearer token. The PoC accepts only read-only requests and deliberately returns `503 browser_adapter_not_ready` until a real adapter is live-tested:
```sh
curl -X POST http://localhost:3005/api/task \
  -H "Authorization: Bearer $BRANCH5_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"task":"Read the public title and summary of https://example.com","mode":"read_only"}'
```

Do not expose this endpoint publicly without HTTPS, network access controls, and a proper secret-management setup. The current scaffold does not implement a production-ready browser worker, remote desktop, encrypted persistent profile, request queue, or session-management flow. The extension ZIP itself has no HTTP/WebSocket server API for external task submission; it communicates through Chrome extension messaging and the Gemini website UI. Therefore, the existing `/api/task` route cannot control it as-is. A separate, authenticated browser-control adapter must be designed and tested against the live extension UI before the API can be enabled.

## Safety limits

- No automatic account creation, login submission, form submission, publication, deletion, payment, permission changes, or other high-impact actions.
- No task is claimed successful without a verified browser result.
- Rate limit: 10 authenticated requests per source IP per minute; request body capped at 8 KiB.
- No prompt body or authorization token is written to logs.
- No Gemini API key is used by this scaffold, but it also does not yet provide Gemini responses.
- No branch 1–3 changes, no Yemot settings changes, no deployment, no merge.

## Current verification results

- Isolated GitHub Actions workflow for the branch 5 HTTP/security tests passed.
- The supplied extension archive was recovered from the user's Library and inspected; the corrected static checker passed 10 checks, validated manifest-referenced assets, and scanned 18 source files.
- The extension's supplied Node test suite passed: 62 passed, 0 failed.
- A local attempt to start system Chromium and navigate to Gemini did not finish within the 25-second limit in this execution environment; therefore Chromium extension loading, Gemini sign-in, and a real read task are **not verified**.
- No live Gemini prompt was sent.
- No cloud browser service or remote sign-in session has been created.

## Next gate

The next manual requirement is to provide a secured interactive cloud-browser session where an authorized person can sign in to a dedicated test account. Then rerun the extension smoke test and, only if the composer is genuinely available, perform one harmless read-only prompt and verify the actual response. Do not connect to Yemot or deploy until those checks pass and the change is separately approved.
