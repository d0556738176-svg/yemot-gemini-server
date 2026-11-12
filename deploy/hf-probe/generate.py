"""One short Hebrew song through the official ACE-Step Space, using the
official gradio_client with named parameters of /generation_wrapper."""
import json, os, shutil, sys, time, traceback
from gradio_client import Client

OUT = sys.argv[1]
os.makedirs(OUT, exist_ok=True)
rep = {"attempts": []}
LYR = "[Verse 1]\nשבת שלום לכל המשפחה\nנרות דולקים והבית בשמחה\n[Chorus]\nשבת שלום שבת שלום\nשיר של שמחה מכל מקום"
SPACES = os.environ.get("SPACES", "ACE-Step/Ace-Step-v1.5,MBLF/ACE-Step-1.5").split(",")
rep["ok"] = False
for space in SPACES:
    a = {"space": space}
    t0 = time.time()
    try:
        c = Client(space, token=os.environ.get("HF_TOKEN") or None, verbose=False)
        api = c.view_api(return_format="dict", print_info=False)["named_endpoints"].get("/generation_wrapper")
        if not api:
            a["error"] = "no /generation_wrapper"; rep["attempts"].append(a); continue
        names = {p["parameter_name"]: p for p in api["parameters"]}
        want = {
            "generation_mode": "custom", "simple_query_input": "", "simple_vocal_language": "he",
            "param_4": "joyful hebrew shabbat song, warm male vocals, acoustic guitar, clarinet",
            "param_5": LYR, "param_9": "he", "param_14": None, "param_15": 40, "param_16": 1,
            "param_17": None, "param_18": "", "param_30": "mp3", "param_47": None,
        }
        if "selected_model" in names:
            want["selected_model"] = names["selected_model"].get("parameter_default")
        kwargs = {k: v for k, v in want.items() if k in names}
        a["model"] = want.get("selected_model")
        res = c.predict(api_name="/generation_wrapper", **kwargs)
        a["seconds"] = round(time.time() - t0, 1)
        a["status_text"] = str(res[10])[:300]
        first = res[0]
        path = first.get("path") if isinstance(first, dict) else first
        if path and os.path.exists(path):
            shutil.copy(path, os.path.join(OUT, "hf-test-song.mp3"))
            a["bytes"] = os.path.getsize(path)
            a["details"] = str(res[9])[:600]
            rep["ok"] = True; rep["space"] = space
            rep["attempts"].append(a)
            break
    except Exception as e:
        a["seconds"] = round(time.time() - t0, 1)
        a["error"] = repr(e)[:600]
    rep["attempts"].append(a)
with open(os.path.join(OUT, "generate.json"), "w") as f:
    json.dump(rep, f, ensure_ascii=False, indent=1)
print(json.dumps(rep, ensure_ascii=False))
