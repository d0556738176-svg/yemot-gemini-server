# Real isolated johnvc trial — 2026-11-02

No production service, IVR settings, secrets or provider routing changed. One manually authorized run only; no duplicate provider run.

- Actor: johnvc/youtube-download-api, ID ROmcK1i9P5fksADtG, build 0.1.28.
- Run: 2oJOGs60W3kKqBC3i.
- Input video: https://www.youtube.com/watch?v=9scnWAgV6us
- Title: 1 Hour of Incredible Animals Narrated by David Attenborough | BBC Earth.
- Input: audio, m4a, standard, maxMinutes 90, maxMegabytes 150, storageProvider apify. No cookies supplied.
- Run cap $0.01, timeout 1800 seconds, memory 1024MB.
- Started 17:14:35Z, finished 17:19:17Z (19:19:17 Israel), elapsed 4m42s, exit 0.
- Four internal fetch attempts logged blocked; fifth succeeded. No change of provider settings during run.
- Delivered 21,880,280 bytes, AAC 44.1kHz stereo (~49kbps reported), metadata duration 3595 seconds.
- SHA-256 from provider matched actual downloaded bytes: 7bb02cba811776609fde908671c59198a3ce24f642f3e6a6debc1b7ab59b3ca3.
- Local ffprobe source duration 3594.913379 seconds.
- Actual file downloaded from existing Apify KV record, no new source run. Browser initial download helper timed out; native media Download succeeded.
- Hardened pipeline converted this real M4A to PCM s16le mono 8kHz WAV, duration 3594.913375 seconds; complete PCM frame validation passed.
- Additional full FFmpeg output decode with -xerror exited 0.
- Provider log Total amount charged: $0.000680; UI rounds to $0.001. Earlier website-only estimate understated actual cost slightly.
- No Yemot upload performed, no telephone playback tested, no automatic integration deployed. One successful file does not guarantee other videos or durations.

Console: https://console.apify.com/actors/ROmcK1i9P5fksADtG/runs/2oJOGs60W3kKqBC3i#log

Do not commit signed media links, UI auth tokens, source media or other credentials.
