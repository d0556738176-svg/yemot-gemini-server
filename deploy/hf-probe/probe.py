"""Probe the official ACE-Step 1.5 Hugging Face Space with the official
gradio_client: dump its API, then try one short Hebrew generation."""
import json, os, sys, time, traceback
from gradio_client import Client

OUT = sys.argv[1]
os.makedirs(OUT, exist_ok=True)
rep = {}
token = os.environ.get("HF_TOKEN") or None
space = os.environ.get("SPACE", "ACE-Step/Ace-Step-v1.5")
t0 = time.time()
try:
    c = Client(space, hf_token=token, verbose=False)
    info = c.view_api(return_format="dict", print_info=False)
    with open(os.path.join(OUT, "api.json"), "w") as f:
        json.dump(info, f, ensure_ascii=False, indent=1, default=str)
    rep["endpoints"] = list((info or {}).get("named_endpoints", {}).keys())
except Exception as e:
    rep["client_error"] = repr(e)[:800]
    rep["trace"] = traceback.format_exc()[-1500:]
rep["seconds"] = round(time.time() - t0, 1)
with open(os.path.join(OUT, "probe.json"), "w") as f:
    json.dump(rep, f, ensure_ascii=False, indent=1)
print(json.dumps(rep, ensure_ascii=False)[:3000])
