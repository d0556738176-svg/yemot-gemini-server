"""Extension 4 song worker (runs on a free GitHub Actions runner).

Takes one song job from the workflow inputs, generates it with the local
ACE-Step 1.5 API server (started by the workflow on this runner, CPU), and
posts the mp3 back to the phone server. Status pings let the phone server
tell a waiting caller what stage the song is in. Never prints the ticket.

env: JOB_ID, CALLBACK_URL, TICKET, PAYLOAD (base64 JSON), ACESTEP_API_KEY
"""
import base64, json, os, sys, time, urllib.error, urllib.parse, urllib.request

JOB = os.environ["JOB_ID"]
CB = os.environ["CALLBACK_URL"]
TICKET = os.environ["TICKET"]
RAW = os.environ["PAYLOAD"]
P = json.loads(base64.b64decode(RAW).decode("utf-8"))
KEY = os.environ["ACESTEP_API_KEY"]
API = "http://127.0.0.1:8001"
T0 = time.time()


def log(*a):
    print(f"[{round(time.time() - T0)}s]", *a, flush=True)


def callback(kind, body=None, **extra):
    q = {"job": JOB, "ticket": TICKET, "kind": kind, **extra}
    headers = {"content-type": "audio/mpeg" if body else "application/json"}
    if kind == "audio":
        headers["x-song-payload"] = RAW
    for attempt in range(6):
        try:
            req = urllib.request.Request(CB + "?" + urllib.parse.urlencode(q), data=body or b"{}", headers=headers, method="POST")
            with urllib.request.urlopen(req, timeout=180) as r:
                log("callback", kind, r.status)
                return True
        except Exception as e:  # the free phone server may be waking up
            log("callback retry", kind, attempt, str(e)[:120])
            time.sleep(15 * (attempt + 1))
    return False


def api(path, body=None, timeout=60, raw=False):
    req = urllib.request.Request(API + path, data=None if body is None else json.dumps(body).encode(),
                                 headers={"Authorization": "Bearer " + KEY, "Content-Type": "application/json"},
                                 method="GET" if body is None else "POST")
    with urllib.request.urlopen(req, timeout=timeout) as r:
        d = r.read()
        return d if raw else json.loads(d)


def main():
    callback("status", stage="starting")
    deadline = time.time() + 1500
    while True:
        try:
            api("/health", timeout=30); break
        except Exception as e:
            if time.time() > deadline: raise RuntimeError("ACE-Step server did not start: " + str(e)[:100])
            time.sleep(10)
    log("server up")
    callback("status", stage="generating")
    sub = api("/release_task", {
        "prompt": P["prompt"], "lyrics": P["lyrics"], "vocal_language": P.get("language", "he"),
        "audio_duration": int(P.get("duration", 90)), "thinking": False, "use_format": False,
        "model": "acestep-v15-turbo", "task_type": "text2music", "audio_format": "mp3",
        "inference_steps": 8, "batch_size": 1, "use_random_seed": True,
    }, timeout=120)
    task = (sub.get("data") or {}).get("task_id")
    if not task: raise RuntimeError("no task id: " + json.dumps(sub)[:200])
    t1 = time.time()
    while True:
        time.sleep(5)
        rows = api("/query_result", {"task_id_list": [task]}).get("data") or []
        row = rows[0] if rows else {}
        if row.get("status") == 2: raise RuntimeError("generation failed: " + str(row)[:300])
        if row.get("status") == 1:
            res = row["result"]; res = json.loads(res) if isinstance(res, str) else res
            audio = api(res[0]["file"], raw=True, timeout=120)
            log("generated", len(audio), "bytes in", round(time.time() - t1), "s")
            if len(audio) < 20000: raise RuntimeError("audio too small")
            with open("song.mp3", "wb") as f: f.write(audio)
            if not callback("audio", audio): raise RuntimeError("could not deliver the song")
            return
        if time.time() - t1 > 3300: raise RuntimeError("generation timed out")


try:
    main()
except Exception as e:
    log("FAILED", str(e)[:300])
    callback("error", message=str(e)[:250])
    sys.exit(1)
