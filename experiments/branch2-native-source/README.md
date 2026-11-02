# Isolated branch 2 native source experiment

Independent implementation informed by review of tsoolgee/youtube-premium and Yonatan360-cyber/YTDH. No third-party source or cookies copied.

Explicit manual CLI only. No changes to server.js, render.yaml, existing download routing or Yemot configuration. Never deploy this branch as the existing service.

Requires Linux, Python 3, yt-dlp, FFmpeg and ffprobe. Downloads native audio without MP3 postprocessing; converts locally to mono 8kHz PCM WAV. Silent subprocesses have enforced stage deadlines and process-group termination. Validated source is kept across conversion failure. A per-video local lock prevents parallel work; stale locks after crashes require review. Cache is local, not durable on a free Render filesystem. This is not production ready: no hosted endpoint, file-size/disk quota, durable queue, phone chunk upload or automatic restart recovery yet.

Manual CLI: `python experiments/branch2-native-source/pipeline.py VIDEO_ID --root /tmp/branch2-poc --expected-seconds 4043`

Offline-only mode: add `--local-source PATH`. Never supply session cookies or disable certificate validation.

Measured validation: generated 4043-second sine WAV, 64688078 bytes; converted result 4043 seconds; repeat preparation reused the existing source and output after the input fixture was removed; a silent 30-second subprocess was terminated by a 0.2-second deadline. These are synthetic/offline results, not evidence of YouTube download, production Render performance, Yemot upload or phone playback. Real YouTube cloud availability remains unverified; no provider credit used.
