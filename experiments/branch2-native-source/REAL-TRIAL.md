# Real download trial, 2026-11-02

Video: jNQXAC9IVRw (short control before long-video testing).

Runtime: yt-dlp 2026.10.26, yt-dlp-ejs 0.8.0, Node, system FFmpeg/ffprobe. No cookies or Apify keys used. No production deploy, routing or Yemot changes.

1. Default Python trust failed with CERTIFICATE_VERIFY_FAILED (self-signed certificate in chain).
2. Existing system CA bundle via SSL_CERT_FILE plus no-certifi compatibility preserved certificate verification and allowed metadata retrieval and Node challenge processing.
3. Requested native audio format 251. Downloader reported 100%, but wrote only 195 bytes.
4. ffprobe rejected the result: EBML header parsing failed / Invalid data found when processing input.
5. File contents were an HTML Site Unavailable page, not media. No valid source duration, conversion, upload or phone playback was established.

The precise origin of that HTML response (network intermediary versus upstream service) is not established by its generic text. Do not label this a proven YouTube bot wall or an SSL fix for the separate memo23 failure.

Do not upload this response to Yemot or mark this trial successful. No real hour-long download attempted after this control failure. Upload remains blocked by missing valid media; local runtime also has no separately configured test-only Yemot credential. Production credentials were not retrieved.
