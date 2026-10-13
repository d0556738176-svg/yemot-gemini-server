# Branch 4 — ACE-Step song generator

This feature branch adds an isolated `/yemot-song` handler for Yemot extension `ivr2:/4`. It does not change the request handlers for extensions 1–3.

## Generation flow

1. Capture the caller's request using the existing phone transcription path.
2. Use the configured Gemini chain to create a structured song specification and original lyrics.
3. Submit lyrics, language, style, and a 30–60 second duration to a separately hosted ACE-Step 1.5 API.
4. Poll the documented ACE-Step task endpoint with a bounded timeout and download the completed audio from the same API origin.
5. Convert audio to 8 kHz mono PCM WAV chunks using the repository's existing `ffmpeg-static` dependency.
6. Upload each chunk to a unique path under `ivr2:/4/songs/`, verify the uploads, and play only verified files.

ACE-Step is a separate Python/GPU service; it is not installed inside the Node/Render IVR service. The IVR requires an HTTPS API URL and a secret API key.

## Render environment

- `ACESTEP_API_URL`: base URL of the separately hosted ACE-Step API (HTTPS required outside localhost).
- `ACESTEP_API_KEY`: same secret configured as `ACESTEP_API_KEY` on the ACE-Step server.
- `ACESTEP_MODEL`: defaults to `acestep-v15-turbo`.
- `ENABLE_BRANCH4`: must be explicitly set to `true` before automatic Yemot extension 4 setup is attempted; default is `false`.
- `YEMOT_API_KEY`: existing Yemot upload credential.
- `SONG_GENERATION_TIMEOUT_MS`: bounded generation wait, default 180000 ms and maximum 300000 ms.
- `SONG_WAIT_PROMPT_TIMEOUT_MS`: IVR progress prompt interval, default 15000 ms.
- `SONG_MAX_CONCURRENT`, `SONG_MAX_QUEUE`, `SONG_MAX_PER_HOUR`: generation safeguards.
- Optional `MUSIC_BACKUP_API_URL` and `MUSIC_BACKUP_API_KEY`: only use a verified provider whose API returns raw audio bytes.

The ACE-Step API uses `/release_task`, `/query_result`, and `/v1/audio`. Responses, task failures, timeout, output size, and audio origin are checked. The default config leaves extension 4 untouched.

## Validation and deployment safety

- This branch must pass CI and regression tests before merge.
- Do not deploy it directly to production before testing the external ACE-Step service and actual phone playback.
- CI cannot validate a live GPU service, model download, API key/quota, Yemot permissions, or audible playback.
- Do not merge until a real audio-generation and Yemot phone-playback test succeeds.