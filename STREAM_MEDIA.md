# Free web-media streaming path

Extension 2 resolves public Mako viewing tickets, renews them before download,
and keeps the ticket's User-Agent and Referer. Rejected entitlements do not
produce playable items. No login, paid API, or external decryption key is used.

When `/usr/local/bin/N_m3u8DL-RE` exists (or `N_M3U8DL_RE_PATH` identifies an
installed binary), web HLS/DASH items first use that tool. YouTube retains its
existing path. Without the binary, the existing yt-dlp path remains available.
The streaming fallback follows the regular job's video-resolution ceiling and
selects the best available audio source. It uses two download
threads, verifies segment counts, limits stalled jobs, kills its process group
on cancellation, and removes its temporary directory. FFmpeg creates the
video or audio-only output consumed by the existing conversion/upload jobs.

`bash install-stream-downloader.sh` installs the official Linux x86_64 release
after SHA-256 verification. It requires permission to write `/usr/local/bin`;
it does not change credentials, IVR settings, or restart services. Installation
on the production VPS must be verified separately from a repository merge.

## Validation

- 48 targeted tests passed, including real N_m3u8DL-RE/FFmpeg downloads of a
  generated HLS fixture that requires the correct User-Agent and Referer, in
  video and audio-only modes. Set `NM_TEST_BIN` to enable that integration test.
- The actual Mako episode downloaded with N_m3u8DL-RE in a separate environment:
  235,095,045 bytes; ffprobe duration 3133.461 seconds, H.264 video and AAC audio.
  FFmpeg decoded the entire audio stream without reporting an error.
- The phone-menu tests execute the real webFlow handler with phone and job
  boundaries mocked: 20 items, 0 for page 21–40, two-digit selection, audio and
  video job routing, audio-only results, and 00 for a new search.
- Production VPS installation and an actual Yemot telephone call remain separate
  acceptance checks; repository tests do not prove either one.

## 18.11 fix: runs inside a terminal, reports percent, one combined file

- The tool crashes at a random moment ("Offset and length were out of bounds",
  Spectre.Console) when its output is not a terminal, so long downloads failed
  silently. It now runs inside a pseudo-terminal (`script`), which is also where
  its progress bars are read from: the caller hears real percent (segments done).
- `-M format=mkv` joins separate audio and video tracks into one file (before,
  two files failed the job).
- Web downloads get the same time budget as a regular extension 2 job (6 hours,
  a stalled download still stops after a minute), instead of 15 minutes.
