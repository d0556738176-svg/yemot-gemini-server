# External experiment container

Build from repository root:

`docker build -f experiments/branch2-native-source/Dockerfile -t branch2-audio-poc .`

Default command executes offline validation tests only. This image is not a web service and must not replace the production Render start command. No automatic download or paid actor run starts at boot.

Includes Python, Node, yt-dlp, yt-dlp-ejs, system Chromium, Xvfb, FFmpeg, ffprobe and reviewed youtube-premium extension source. Native Linux pipeline and browser extension remain separate experimental paths; extension-to-IVR integration is not implemented.

No SaveBridge installation: its download path transfers session cookies to a third-party relay and is not an independent self-hosted engine. No Windows YTDH executables or repository cookies are copied. No claims that combining tools removes network restrictions.

Current environment has no Docker daemon, Chromium or Xvfb available; image build and browser path have NOT been run. No external server has been provisioned by this commit. Native trial previously returned HTML instead of media. A deployment requires an isolated Linux host with sufficient memory and a supported browser interaction path. No production credentials are embedded.
