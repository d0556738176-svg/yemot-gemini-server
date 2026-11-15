"""Generate one song from song-direct/request.json with the local ACE-Step API
and save it as song-direct/out/<name>.mp3 (the workflow commits it back)."""
import json, os, time, urllib.request
P = json.load(open("song-direct/request.json", encoding="utf-8"))
KEY = os.environ["ACESTEP_API_KEY"]; API = "http://127.0.0.1:8001"; T0 = time.time()
def api(path, body=None, timeout=60, raw=False):
    req = urllib.request.Request(API + path, data=None if body is None else json.dumps(body).encode(),
        headers={"Authorization": "Bearer " + KEY, "Content-Type": "application/json"},
        method="GET" if body is None else "POST")
    with urllib.request.urlopen(req, timeout=timeout) as r:
        d = r.read(); return d if raw else json.loads(d)
while True:
    try: api("/health", timeout=30); break
    except Exception:
        if time.time() - T0 > 1500: raise
        time.sleep(10)
print("server up", round(time.time() - T0), flush=True)
sub = api("/release_task", {"prompt": P["prompt"], "lyrics": P["lyrics"], "vocal_language": P.get("language", "he"),
    "audio_duration": int(P.get("duration", 120)), "thinking": False, "use_format": False, "model": "acestep-v15-turbo",
    "task_type": "text2music", "audio_format": "mp3", "inference_steps": 8, "batch_size": 1, "use_random_seed": True}, timeout=120)
task = sub["data"]["task_id"]; t1 = time.time()
while True:
    time.sleep(5)
    row = (api("/query_result", {"task_id_list": [task]}).get("data") or [{}])[0]
    if row.get("status") == 2: raise SystemExit("generation failed: " + str(row)[:300])
    if row.get("status") == 1:
        res = row["result"]; res = json.loads(res) if isinstance(res, str) else res
        audio = api(res[0]["file"], raw=True, timeout=120)
        os.makedirs("song-direct/out", exist_ok=True)
        open(f"song-direct/out/{P['name']}.mp3", "wb").write(audio)
        print("done", len(audio), "bytes in", round(time.time() - t1), "s", flush=True); break
    if time.time() - t1 > 3300: raise SystemExit("timeout")
