# Branch 4 — Song Generator

Branch 4 is isolated behind the /yemot-song route and Yemot extension ivr2:/4. It does not replace the existing handlers for branches 1, 2, or 3.

## Flow

1. Reuse the existing Hebrew speech-to-text function.
2. Reuse the existing Gemini model/key fallback chain to produce a structured JSON song specification and original lyrics.
3. Generate a 30–60 second composition using Eleven Music music_v2_5 and a composition plan.
4. Convert the returned MP3 to 8 kHz mono PCM WAV chunks with the already-installed ffmpeg-static.
5. Upload each chunk to a unique Yemot path under ivr2:/4/songs/ and verify it with GetFile.
6. Optionally archive the MP3 in Supabase Storage and save metadata to generated_songs.
7. Play the verified Yemot files only after all required upload checks succeed.

## Render environment

Required to enable generation/playback:
- ELEVENLABS_API_KEY
- YEMOT_API_KEY (already used by the existing authorized-audio uploader)

Optional:
- MUSIC_BACKUP_API_URL
- MUSIC_BACKUP_API_KEY
- MUSIC_BACKUP_MODEL
- SONG_STORAGE_BUCKET (create this bucket in Supabase first)
- SONG_GENERATION_TIMEOUT_MS (default 120000)
- SONG_WAIT_PROMPT_TIMEOUT_MS (default 15000)
- SONG_MAX_CONCURRENT (default 2)
- SONG_MAX_QUEUE (default 4)
- SONG_MAX_PER_HOUR (default 2)

The backup adapter is intentionally provider-neutral: it sends a JSON POST containing title, lyrics, genre, mood, duration_seconds and music_prompt with a Bearer key, and expects the response body to be audio bytes. It is not represented as an official Suno API. Configure it only for a provider whose API contract has been verified. If no backup provider is configured, a primary-provider failure returns a short, explicit failure message instead of hanging.

## Database migration

If Supabase is enabled, run the added generated_songs section in supabase.sql before expecting metadata persistence. If the table is not yet present, audio generation/playback still proceeds and the metadata-write failure is logged. Supabase Storage archiving is optional and requires the bucket named by SONG_STORAGE_BUCKET.

## Test/deployment safety

- This feature branch must pass CI and regression tests before merging.
- Do not deploy this branch directly to production before phone testing.
- Merging it will add only the /yemot-song route and configure extension 4; it does not change the handlers for extensions 1–3.
- Test the actual Yemot phone playback before creating the stable-after tag/branch. CI cannot verify a real provider account, API quota, Yemot upload permissions, or audible playback.
