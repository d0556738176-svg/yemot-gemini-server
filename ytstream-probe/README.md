# YTStream: isolated Render download diagnostic

This is not a production IVR adapter. It never changes Yemot settings, uploads audio, or touches extension 2.

## Reproduction, 2026-10-28

The earlier assistant-environment request returned API `200 / OK`, but media downloads returned an HTML `Site Unavailable` page. Those responses did not establish that a valid audio file could be downloaded.

A dedicated **free Frankfurt Render service** was created on branch `diagnostics/ytstream-render-audio-20261028`. Initial commit `1cae4d5acb0c7b7e318952555e4634ba32988dbe` became live. With `cgeo=DE`, the request from Render also returned API `OK`, followed by:

1. `redirector.googlevideo.com`: HTTP 302.
2. The resulting Googlevideo audio CDN: HTTP 403.
3. Both tested audio formats (140 and 249) failed at the media stage. No conversion, upload, or phone playback succeeded.

This narrows the fault to access to the returned media URL, rather than the API subscription or parsing the metadata. It does **not** prove whether the cause is IP binding, signature validity, regional availability, or another CDN restriction.

## Diagnostic safeguards / fixes

- Reject HTML/JSON even when HTTP status is successful or a misleading MIME is supplied.
- Validate media container signatures before conversion, then actually decode with FFmpeg.
- Follow a bounded number of HTTPS redirects; allow only Googlevideo hosts and never forward the RapidAPI key to the media host.
- Bound file size, network time and conversion time; clean temporary media.
- Keep API key and probe secret only in runtime environment variables. No signed media URLs or credentials are returned to the caller or logged.
- At most one provider API request per running process; repeated requests return the cached diagnostic result. Restarts reset this cache.
- Public `/health` makes no provider calls. `/probe` (POST) and `/result` (GET) require `X-Probe-Secret`. No keep-alive is configured.

The follow-up revision optionally sets `PROBE_GEO`; when omitted, it requests the provider's automatic behavior. It reports whether a proxy URL was supplied and its hostname without exposing that URL. Unexpected proxy hosts are reported and not fetched until independently validated. This is a diagnostic option, not an assertion that proxy mode will work.

## Tests

`node --test ytstream-probe/server.test.mjs` — four local tests pass for HTML rejection, container headers, redirect-host validation, and authenticated/no-side-effect health behavior. Those tests are not proof of YouTube media access or Yemot playback.

## Deployment

Docker context `ytstream-probe`, Dockerfile `ytstream-probe/Dockerfile`; Node 22 plus FFmpeg. Bind to `0.0.0.0:$PORT`. Required runtime secrets: `RAPIDAPI_KEY` and `PROBE_SECRET`. Do not paste them into this README or Git. Do not merge this diagnostic into production as an implemented download feature.
