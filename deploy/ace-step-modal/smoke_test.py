"""Live smoke test for the Modal ACE-Step API used by extension 4.

Uses the exact request shape the Node service sends (buildAceStepPayload in
song-generator.js): Hebrew lyrics, vocal_language=he, thinking=true, mp3.
Writes a JSON report and the generated mp3. Never prints the API key.

Usage: python smoke_test.py <base_url> <out_dir>   (key in ACESTEP_API_KEY)
"""
import json
import os
import sys
import time
import urllib.error
import urllib.parse
import urllib.request

BASE = sys.argv[1].rstrip("/")
OUT = sys.argv[2]
KEY = os.environ["ACESTEP_API_KEY"]
os.makedirs(OUT, exist_ok=True)
report = {"base_url": BASE, "steps": []}

LYRICS = (
    "[Verse 1]\n"
    "שבת שלום לכל המשפחה\n"
    "נרות דולקים והבית בשמחה\n"
    "[Chorus]\n"
    "שבת שלום שבת שלום\n"
    "שיר של שמחה מכל מקום\n"
)
PAYLOAD = {
    "prompt": "joyful hebrew shabbat song, warm male vocals, acoustic guitar, clarinet, mid-tempo",
    "lyrics": LYRICS,
    "vocal_language": "he",
    "audio_duration": 45,
    "thinking": True,
    "use_format": False,
    "use_cot_caption": True,
    "use_cot_language": True,
    "model": "acestep-v15-turbo",
    "task_type": "text2music",
    "audio_format": "mp3",
    "inference_steps": 8,
    "batch_size": 1,
    "use_random_seed": True,
}


def step(name, **data):
    data["name"] = name
    data["t"] = round(time.time() - T0, 1)
    report["steps"].append(data)
    print(json.dumps(data, ensure_ascii=False), flush=True)


def call(path, body=None, timeout=60, raw=False):
    req = urllib.request.Request(
        BASE + path,
        data=None if body is None else json.dumps(body).encode(),
        headers={"Authorization": "Bearer " + KEY, "Content-Type": "application/json"},
        method="GET" if body is None else "POST",
    )
    with urllib.request.urlopen(req, timeout=timeout) as r:
        data = r.read()
        return (data, r.headers.get("content-type", "")) if raw else json.loads(data)


def save():
    with open(os.path.join(OUT, "report.json"), "w", encoding="utf-8") as f:
        json.dump(report, f, ensure_ascii=False, indent=2)


T0 = time.time()
ok = False
try:
    # Cold start: GPU boot + first model download can take many minutes.
    deadline = time.time() + 1500
    while True:
        try:
            h = call("/health", timeout=120)
            step("health", ok=True, body=h)
            break
        except Exception as e:  # noqa: BLE001
            if time.time() > deadline:
                raise
            step("health_wait", error=str(e)[:160])
            time.sleep(20)

    # Unauthenticated request must be rejected (the API key really protects it).
    try:
        urllib.request.urlopen(urllib.request.Request(BASE + "/release_task", data=b"{}",
                               headers={"Content-Type": "application/json"}, method="POST"), timeout=60)
        step("auth_check", protected=False)
    except urllib.error.HTTPError as e:
        step("auth_check", protected=e.code in (401, 403), http=e.code)

    sub = call("/release_task", PAYLOAD, timeout=120)
    task_id = (sub.get("data") or {}).get("task_id")
    step("submitted", task_id=task_id, code=sub.get("code"))
    submitted_at = time.time()
    file_url = None
    while time.time() - submitted_at < 900:
        time.sleep(4)
        q = call("/query_result", {"task_id_list": [task_id]}, timeout=60)
        rows = q.get("data") or []
        row = rows[0] if rows else {}
        status = row.get("status")
        if status == 2:
            step("failed", row=str(row)[:600])
            break
        if status == 1:
            res = row.get("result")
            res = json.loads(res) if isinstance(res, str) else res
            file_url = res[0]["file"]
            step("generated", gen_seconds=round(time.time() - submitted_at, 1),
                 metas=res[0].get("metas"), lm_model=res[0].get("lm_model"), dit_model=res[0].get("dit_model"))
            break
    if file_url:
        audio, ctype = call(file_url, raw=True, timeout=120)
        with open(os.path.join(OUT, "test-song.mp3"), "wb") as f:
            f.write(audio)
        step("downloaded", bytes=len(audio), content_type=ctype)
        ok = len(audio) > 20000 and ("audio" in ctype or "mpeg" in ctype)
except Exception as e:  # noqa: BLE001
    step("error", error=str(e)[:400])

report["ok"] = ok
report["total_seconds"] = round(time.time() - T0, 1)
save()
sys.exit(0 if ok else 1)
