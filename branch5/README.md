# Branch 5 — Gemini Browser Bridge cloud PoC (isolated)

**Status: scaffold only; not production-ready, not deployed, not connected to Yemot.**

This directory is deliberately independent. It does not import the root `server.js`, does not read Yemot management credentials, does not call Yemot APIs, and does not edit the root `render.yaml`. The server starts only when run directly from this directory.

## Verified technical boundary

Gemini Browser Bridge 0.2.2 is a Chrome extension for a live browser tab and side panel; it is not an HTTP backend. Playwright can load Chromium extensions when using a persistent context, but that alone does not prove this extension can drive a live Gemini session in a headless cloud container. This PoC therefore fails closed: it does not send a Gemini prompt and its task endpoint returns `503 browser_adapter_not_ready`.

## Local checks

Requires Node.js 22+.

```sh
cd branch5
npm install
npm test
```

## Isolated HTTP service

Set a random secret of at least 32 characters, then start:

```sh
export BRANCH5_TOKEN="$(node -e "console.log(require('node:crypto').randomBytes(32).toString('hex'))")"
npm start
```

Health check (intentionally public, no secrets):
```sh
curl http://localhost:3005/health
```

Authenticated status:
```sh
curl -X POST http://localhost:3005/api/status \
  -H "Authorization: Bearer $BRANCH5_TOKEN"
```

Task requests require the same Bearer token. The PoC only accepts read-only requests and deliberately returns 503 until a live-tested adapter exists:
```sh
curl -X POST http://localhost:3005/api/task \
  -H "Authorization: Bearer $BRANCH5_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"task":"Read the public title and summary of https://example.com","mode":"read_only"}'
```

Do not expose this endpoint publicly without HTTPS and access controls. Never place the token in a URL or logs. This prototype does not yet implement a production-ready session store, browser worker, persistent profile encryption, remote desktop/login bootstrap, or request queue.

## Optional browser extension smoke test

Copy the *extracted* Gemini Browser Bridge extension directory to a private test environment and run:

```sh
BRIDGE_EXTENSION_DIR=/absolute/path/to/Gemini-Browser-Bridge npm run browser:smoke
```

The script checks whether Playwright can launch Chromium with the extension and open the Gemini website. It does not sign in, send prompts, click sensitive controls, or verify live Gemini selectors. Use a dedicated test account/profile, never a personal Chrome profile. Cloud login/session bootstrap remains a manual feasibility gate; do not commit cookies, storage state, credentials, or the extension ZIP to Git.

## Safety limits

- No automatic account creation, login submission, form submission, publication, deletion, payment, permission changes, or other high-impact actions.
- The server never claims that a task succeeded.
- Rate limit: 10 authenticated requests per source IP per minute; request body capped at 8 KiB.
- No prompt body or authorization token is written to logs.
- No Gemini API key is used by this scaffold, but it also does not yet provide Gemini responses.
- No branch 1–3 changes, no Yemot settings changes, no deployment, no merge.

## Next gate

Before implementing an adapter, validate current Google terms and account eligibility, confirm that automating the Gemini web UI is allowed for the intended use, and prove the extension works against a real cloud Chromium session. If it fails or requires unsupported quota circumvention, stop and report the limitation.
