# Extension 5 news, isolated and free downloads only

This is a separate service. Nothing imports it from server.js. No existing
route, downloader, root menu, extension 2, or deploy/update script is changed.

## Sources and coverage

Eight configured sources: Kan News, News 12, News 13, C14, i24 Hebrew, ynet,
Knesset TV, Kikar. `app.mjs check` resolves each channel through YouTube's API
and prints the returned identity. Check these identities before activation;
handles can change. Metadata lookup requires existing YouTube API keys from
`/opt/yemot/ext2.env`. It consumes the same free project quota. The collector
never enables billing, creates a paid account, or requests paid media.

The uploads playlist includes Shorts; there is no minimum or maximum duration
filter. Only uploads published since the persistent activation timestamp are
queued, never the historical archive. Ongoing live broadcasts wait until they
finish. Private, removed, region-blocked or otherwise inaccessible videos can
fail. YouTube's API can delay visibility, so immediate delivery is not guaranteed.
Pagination is persistent; the 15-item RSS window cannot lose a burst of uploads.
Polling defaults to five minutes, four pages per source per pass. API quota
failure preserves the queue and resumes later instead of buying a fallback.

## Exact download engine

`adapters.mjs` dynamically imports **only `directDownload` from the existing
extension-2 `youtube-direct.js`** at `/opt/yemot/ext2/youtube-direct.js`.
It never imports the generic playback pipeline or alternate/paid engines.
The wrapper runs the same `/usr/local/bin/yt-dlp` binary, capped at 512 KiB/s
and one fragment. On failure, retry in the persistent queue, at most three
attempts, then retain a visible failed row. It never asks a paid provider.

## Load control and recovery

- One background download at a time; no overlapping ticks or worker processes.
- Existing yt-dlp/FFmpeg processes outside this service, high load or less than
  2 GiB free disk postpone a new job. A job already started is not preempted
  when another caller starts downloading; systemd CPU/I/O priority and bandwidth
  caps reduce contention. This is resource isolation, not a shared priority queue.
- systemd limits the entire process group to 25% of one CPU, 768 MiB RAM, 64 tasks,
  nice 15, idle I/O. SIGTERM aborts the downloader and systemd kills remaining
  children. `systemctl stop yemot-news5` stops it without a retry timer restarting it.
- A 30-minute job budget, a 512 MiB source-file cap and a running free-disk check
  prevent a huge or stalled item filling the server. Long videos are not filtered
  by duration but can hit these resource budgets and appear as failed.
- FIFO work avoids starving older uploads. Playback is independently sorted by
  publication date, newest first, even when an older download finishes later.
- SQLite WAL preserves jobs and source cursors; deterministic per-video remote
  paths make interrupted retries idempotent. Partial uploads never become ready.
- Each WAV chunk is verified with GetFile and exact byte size before publication.
- No existing files are deleted. Local temporary media is removed after each job.
  Uploaded news accumulates in `/5/news`; monitor Yemot capacity. A retention
  policy must be chosen before unattended long-term operation.

## Install and verify without affecting active extensions

1. Make a separate checkout at `/opt/yemot/news5` of this feature branch. Do not
   merge into `main`: the existing auto-updater may restart active services.
2. Run `bash branch5-news/install.sh` there. It installs a new service in preview
   mode (`NEWS5_ENABLED=false`); no downloading or Yemot configuration occurs.
3. Load `/opt/yemot/news5.env` into the shell without printing it, and run
   `node branch5-news/app.mjs check`. All eight identities must be verified.
4. Set `NEWS5_ENABLED=true` in the **new** `/opt/yemot/news5.env` only, and restart
   **only `yemot-news5`**. Let a newly published item complete. Inspect
   `node branch5-news/app.mjs status` and the new service's logs.
5. Expose port 3005 through a dedicated HTTPS Caddy host, preserving the existing
   sites. Validate Caddy configuration before reloading it. Set `NEWS5_PUBLIC_URL`
   in the new service's env to that HTTPS origin. Never expose port 3005 directly.
6. Immediately before activation, back up `/opt/yemot/main.env` and change only
   `BRANCH5_ENABLED=true` and `BRANCH5_LIVE_AUTO_CONFIGURE=false`. Do not restart
   main. These flags prevent the existing main startup code from overwriting /5
   on its next normal restart. No other variable should be changed.
7. `node branch5-news/app.mjs activate` writes only `/5/ext.ini`, after saving its
   previous contents locally and checking that verified audio already exists.
   Do not put the access key in chat or logs. The IVR endpoint embeds it in its path.
8. Make an actual phone test: all-source newest-first feed; each of eight source
   choices; replay, next, previous, refresh and exit; a Short; a new upload;
   reboot recovery; and stopping the new service. HTTP success is not a phone test.

If access to the server, credentials, quota or HTTPS configuration is unavailable,
stop before activation and report it. This repository addition alone is not a
production deployment.

## Tests

`node --test branch5-news/core.test.mjs`

All tests use fake metadata/media/network responses. They cover discovery of
short clips, persistent pagination, failure recovery, deduplication, single-worker
admission, bounded retries, publication ordering, the absence of paid-consent
options, no fallback on direct failure, and verified uploads constrained to /5.
