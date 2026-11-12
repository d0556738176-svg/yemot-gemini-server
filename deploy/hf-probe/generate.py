"""One short Hebrew song through the official ACE-Step Space, using the
official gradio_client with named parameters of /generation_wrapper."""
import json, os, shutil, sys, time, traceback
from gradio_client import Client

OUT = sys.argv[1]
os.makedirs(OUT, exist_ok=True)
rep = {}
t0 = time.time()
try:
    c = Client(os.environ.get("SPACE", "ACE-Step/Ace-Step-v1.5"), token=os.environ.get("HF_TOKEN") or None, verbose=False)
    res = c.predict(
        selected_model=os.environ.get("HF_MODEL", "acestep-v15-xl-turbo"),
        generation_mode="custom",
        simple_query_input="",
        simple_vocal_language="he",
        param_4="joyful hebrew shabbat song, warm male vocals, acoustic guitar, clarinet",
        param_5="[Verse 1]\nשבת שלום לכל המשפחה\nנרות דולקים והבית בשמחה\n[Chorus]\nשבת שלום שבת שלום\nשיר של שמחה מכל מקום",
        param_9="he",
        param_14=None,
        param_15=40,
        param_16=1,
        param_17=None,
        param_18="",
        param_30="mp3",
        param_47=None,
        api_name="/generation_wrapper",
    )
    rep["seconds"] = round(time.time() - t0, 1)
    first = res[0]
    path = first.get("path") if isinstance(first, dict) else first
    rep["status_text"] = str(res[10])[:400]
    rep["details"] = str(res[9])[:800]
    if path and os.path.exists(path):
        shutil.copy(path, os.path.join(OUT, "hf-test-song.mp3"))
        rep["bytes"] = os.path.getsize(path)
        rep["ok"] = True
    else:
        rep["ok"] = False
        rep["first"] = repr(first)[:300]
except Exception as e:
    rep["ok"] = False
    rep["seconds"] = round(time.time() - t0, 1)
    rep["error"] = repr(e)[:1200]
with open(os.path.join(OUT, "generate.json"), "w") as f:
    json.dump(rep, f, ensure_ascii=False, indent=1)
print(json.dumps(rep, ensure_ascii=False))
