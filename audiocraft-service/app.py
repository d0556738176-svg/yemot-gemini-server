import hmac
import os
import tempfile
from pathlib import Path
from threading import Lock

import torch
from fastapi import FastAPI, Header, HTTPException
from fastapi.responses import FileResponse
from pydantic import BaseModel, Field
from starlette.background import BackgroundTask

from audiocraft.data.audio import audio_write
from audiocraft.models import MusicGen

app = FastAPI(title="Branch 4 AudioCraft Instrumental API", version="0.1.0")
MODEL_ID = os.getenv("AUDIOCRAFT_MODEL", "facebook/musicgen-small")
API_TOKEN = os.getenv("AUDIOCRAFT_API_TOKEN", "").strip()
_model = None
_model_lock = Lock()
_generation_lock = Lock()


class InstrumentalRequest(BaseModel):
    style: str = Field(min_length=3, max_length=500)
    duration_seconds: int = Field(default=15, ge=5, le=30)


def require_token(authorization: str | None) -> None:
    if not API_TOKEN:
        raise HTTPException(status_code=503, detail="AudioCraft API token is not configured")
    supplied = ""
    if authorization and authorization.startswith("Bearer "):
        supplied = authorization[7:].strip()
    if not supplied or not hmac.compare_digest(supplied, API_TOKEN):
        raise HTTPException(status_code=401, detail="Unauthorized")


def get_model():
    global _model
    if _model is None:
        with _model_lock:
            if _model is None:
                model = MusicGen.get_pretrained(MODEL_ID)
                if torch.cuda.is_available():
                    model = model.to("cuda")
                _model = model
    return _model


@app.get("/health")
def health():
    return {
        "status": "ok",
        "service": "audiocraft-instrumental",
        "model": MODEL_ID,
        "cuda_available": torch.cuda.is_available(),
        "model_loaded": _model is not None,
        "capability": "instrumental_music_only"
    }


@app.post("/v1/instrumental")
def generate_instrumental(request: InstrumentalRequest, authorization: str | None = Header(default=None)):
    require_token(authorization)
    if not _generation_lock.acquire(blocking=False):
        raise HTTPException(status_code=429, detail="A generation job is already running; retry shortly")
    try:
        model = get_model()
        model.set_generation_params(duration=request.duration_seconds)
        prompt = (
            "Instrumental music only, no singing, no speech, no vocals. "
            + request.style.strip()
        )
        with torch.inference_mode():
            waveform = model.generate([prompt])
        with tempfile.TemporaryDirectory(prefix="audiocraft-") as temp_dir:
            output_base = Path(temp_dir) / "instrumental"
            audio_write(
                str(output_base),
                waveform[0].detach().cpu(),
                model.sample_rate,
                strategy="loudness",
                loudness_compressor=True,
            )
            output_file = output_base.with_suffix(".wav")
            if not output_file.exists() or output_file.stat().st_size < 1024:
                raise HTTPException(status_code=502, detail="AudioCraft did not produce a valid WAV file")
            # Copy out of the temporary directory so the response remains available.
            fd, persistent_path = tempfile.mkstemp(prefix="branch4-instrumental-", suffix=".wav")
            os.close(fd)
            Path(persistent_path).write_bytes(output_file.read_bytes())
        return FileResponse(
            persistent_path,
            media_type="audio/wav",
            filename="branch4-instrumental.wav",
            background=BackgroundTask(lambda: Path(persistent_path).unlink(missing_ok=True)),
        )
    except HTTPException:
        raise
    except Exception as exc:
        # Do not expose stack traces, model paths, or secrets to callers.
        print(f"[AudioCraft] generation failed: {type(exc).__name__}: {exc}", flush=True)
        raise HTTPException(status_code=502, detail="Instrumental generation failed") from exc
    finally:
        _generation_lock.release()
