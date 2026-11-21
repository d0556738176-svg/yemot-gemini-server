# Branch 2: YoutubeDL-Material download → Yemot diagnostic

This branch contains an isolated acceptance probe, not a production deployment.
It invokes `backend/youtube-dl.js` from upstream commit
`28234c0d4ba65059be18f3692f6f5e5b1170b1a6` with its actual backend dependencies.
The Angular UI/API server are not launched. The downloader code itself runs.

## Acceptance conditions

1. Download real audio from one of two short public YouTube videos.
2. Validate the file with ffprobe. A download message or exit code 0 is insufficient.
3. Convert up to 20 seconds to PCM signed 16-bit, 8 kHz, mono WAV.
4. If `YEMOT_API_KEY` is securely configured in GitHub Actions secrets, upload only
   to `ivr2:/2/material-selftest/<unique-run-id>/001.wav`.
5. Download the uploaded file back and require identical bytes.

The probe never edits extension menus, ext.ini, live handlers, main, or Render
services. It does not claim that a successful upload proves phone playback.
It does not use cookies, proxy services, a browser, or disabled TLS verification.
No source audio, signed media URLs, credentials, or raw provider errors are saved
as artifacts. Only a diagnostic JSON report is retained for seven days.

## Run

The branch-specific GitHub workflow installs the pinned upstream backend,
yt-dlp 2026.10.26 including its default dependencies, Node 22, and FFmpeg.
The script explicitly enables Node as yt-dlp's JavaScript runtime.

Local invocation after preparing the same upstream backend and executable:

```sh
MATERIAL_BACKEND=/absolute/path/to/YoutubeDL-Material/backend node experiments/material-probe/probe.mjs
```

The backend expects its downloader at `appdata/bin/yt-dlp`.
`PROBE_VIDEO_ID` may select a single 11-character video ID.
Use only content you may download. Failed downloads are never replaced by
synthetic audio and then reported as successful YouTube downloads.

Exit 0 means download, conversion, upload and readback all succeeded. Exit 2
means the chain was not verified; inspect the sanitized report for the stage.

## Findings on 2026-11-02

Initial real upstream run on GitHub Actions:
https://github.com/d0556738176-svg/yemot-gemini-server/actions/runs/41491044935

- `BaW_jenozKc`: video unavailable.
- `jNQXAC9IVRw`: YouTube bot verification challenge.
- GitHub Actions did not receive a configured `YEMOT_API_KEY` secret.
- Conversion and upload were not attempted because no valid audio was obtained.
- Strict upload/readback regression tests passed; those tests use mocks and are
  not evidence of a real upload.

A separate local-cloud attempt had a TLS trust failure. Retesting with system
certificate trust (not disabling TLS checks) printed download completed, but the
result was only 195 bytes and ffprobe rejected it. This is a failed media
download, demonstrating why exit codes/messages alone are insufficient.

Final run with Node 22 explicitly enabled and yt-dlp-ejs 0.8.0 installed:
https://github.com/d0556738176-svg/yemot-gemini-server/actions/runs/41491264901

It completed with the same results: first video unavailable, second video
blocked by YouTube bot verification, no valid source audio, and no conversion
or upload attempted. `fullChainVerified` was false. Both diagnostic regression
tests passed. A failed workflow is expected when the real chain fails. Network-specific failures do not prove
that every cloud server is blocked, or that every YouTube video will fail.
