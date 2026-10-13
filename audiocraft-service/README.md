# Branch 4 — isolated AudioCraft instrumental service

This directory is an **isolated proposed service**. It is not imported by the production Node.js IVR and does not change branches 1–3.

## Important capability boundary

AudioCraft MusicGen generates **instrumental music**, not a vocal performance of supplied lyrics. This service intentionally exposes `POST /v1/instrumental`; it must not be represented as the complete song-with-singing engine. Branch 4 still needs a separate singing/vocal-generation provider before it can turn user-provided lyrics into a sung song. The current IVR must not call this endpoint as if it returned vocals.

Official reference: https://github.com/facebookresearch/audiocraft/blob/main/docs/MUSICGEN.md

## Runtime

- Python / PyTorch / AudioCraft in a separate container.
- GPU strongly recommended. The MusicGen small model is selected as the lower-resource starting point; generation on CPU may be too slow for a phone-call workflow.
- This container is **not intended to be added to the existing free Node Render service**. Deploy only to a separate compatible GPU host.
- Model weights have their own license terms; review the official AudioCraft model-card and weights license before any public or commercial use.

## Environment

Set these variables on the separate service:
- `AUDIOCRAFT_API_TOKEN`: a long random secret; required for generation.
- `AUDIOCRAFT_MODEL`: optional, defaults to `facebook/musicgen-small`.
- `PORT`: supplied by the hosting platform.

Never commit the token to GitHub.

## API

- `GET /health`: non-secret health/capability status.
- `POST /v1/instrumental`: requires `Authorization: Bearer <AUDIOCRAFT_API_TOKEN>`.

Example JSON body:
```json
{
  "style": "upbeat Mediterranean pop, bright strings, hand percussion, bass and drums",
  "duration_seconds": 15
}
```

Successful response: WAV audio bytes, mono/stereo as emitted by the selected model.

## Not production-ready until tested

This is a code scaffold, not proof of a successful model load or real generation. Before connecting it to Yemot, verify container build, GPU availability, model download, authentication failures, a successful WAV response, generation latency, memory use, and audio playback through the Yemot system. Keep the service isolated until those checks pass.
