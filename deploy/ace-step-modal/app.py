"""Isolated ACE-Step 1.5 API deployment for Yemot extension 4.

Deploy with:
  uvx modal deploy deploy/ace-step-modal/app.py

Before deploying, create a Modal Secret named "acestep-api-key" containing
ACESTEP_API_KEY=<long-random-secret>. The same key must be set as
ACESTEP_API_KEY on the Yemot Node service when branch 4 is explicitly enabled.
"""
import subprocess
import time
import urllib.request

import modal

app = modal.App("yemot-branch4-acestep")

MODEL_VOLUME = modal.Volume.from_name("yemot-branch4-acestep-models", create_if_missing=True)
CACHE_VOLUME = modal.Volume.from_name("yemot-branch4-acestep-hf-cache", create_if_missing=True)

PORT = 8001
IMAGE = (
    modal.Image.from_registry("ghcr.io/ace-step/ace-step-1.5:latest")
    .env(
        {
            "ACESTEP_MODE": "api",
            "ACESTEP_API_HOST": "0.0.0.0",
            "ACESTEP_API_PORT": str(PORT),
            "ACESTEP_INIT_SERVICE": "true",
            "ACESTEP_CONFIG_PATH": "acestep-v15-turbo",
            # The smaller LM is a cost/VRAM-conscious starting point.
            "ACESTEP_LM_MODEL_PATH": "acestep-5Hz-lm-0.6B",
            "ACESTEP_LLM_BACKEND": "pt",
            "ACESTEP_OFFLOAD_TO_CPU": "false",
            "TOKENIZERS_PARALLELISM": "false",
        }
    )
)


@app.function(
    image=IMAGE,
    gpu="L4",
    secrets=[modal.Secret.from_name("acestep-api-key")],
    volumes={
        "/app/checkpoints": MODEL_VOLUME,
        "/root/.cache/huggingface": CACHE_VOLUME,
    },
    timeout=1800,
    startup_timeout=900,
    scaledown_window=60,
    max_containers=1,
)
@modal.web_server(port=PORT, startup_timeout=900)
def serve():
    # Run the official container entrypoint in API mode. Modal exposes only
    # this port; API authentication is enforced by ACE-Step's API key.
    proc = subprocess.Popen(["/app/docker-entrypoint.sh"])
    deadline = time.time() + 880
    while time.time() < deadline:
        if proc.poll() is not None:
            raise RuntimeError(f"ACE-Step process exited during startup: {proc.returncode}")
        try:
            with urllib.request.urlopen(f"http://127.0.0.1:{PORT}/health", timeout=2) as response:
                if response.status == 200:
                    break
        except Exception:
            pass
        time.sleep(2)
    else:
        proc.terminate()
        raise TimeoutError("ACE-Step API did not become healthy before startup timeout")


@app.local_entrypoint()
def check():
    """Lightweight remote health check after deployment."""
    url = serve.get_web_url()
    print(f"ACE-Step API endpoint: {url}")
    with urllib.request.urlopen(f"{url.rstrip('/')}/health", timeout=30) as response:
        print(response.read().decode("utf-8"))
