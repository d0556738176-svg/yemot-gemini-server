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


def callback(kind, body=None, ctype="audio/flac", **extra):
    q = {"job": JOB, "ticket": TICKET, "kind": kind, **extra}
    headers = {"content-type": ctype if body else "application/json"}
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


def wait_for_result(task, timeout=3300, poll_seconds=5):
    """Bounded polling tolerates transient HTTP failures without losing a task."""
    started = time.monotonic()
    last_report = started
    failures = 0
    while time.monotonic() - started < timeout:
        time.sleep(poll_seconds)
        try:
            response = api("/query_result", {"task_id_list": [task]})
        except (urllib.error.URLError, TimeoutError, ConnectionError):
            failures += 1
            if failures >= 6:
                raise RuntimeError("ACE-Step result polling failed repeatedly")
            log("result polling retry", failures)
            continue
        failures = 0
        rows = response.get("data") or []
        row = next((r for r in rows if r.get("task_id") == task), {})
        status = row.get("status")
        if status == 2:
            # Do not print result: it can contain caller lyrics and metadata.
            raise RuntimeError("ACE-Step generation failed (status 2)")
        if status == 1:
            result = row.get("result")
            result = json.loads(result) if isinstance(result, str) else result
            if not result or not isinstance(result, list) or not result[0].get("file"):
                raise RuntimeError("ACE-Step completed without an audio file")
            return result[0]["file"]
        now = time.monotonic()
        if now - last_report >= 60:
            log("generation pending", round(now - started), "s; status", status)
            last_report = now
    raise RuntimeError("generation timed out")


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
        "model": "acestep-v15-turbo", "task_type": "text2music",
        # Lossless master (owner, 15.11: "the best quality"); the phone server
        # makes the phone, extension-7 and mp3 copies from it.
        "audio_format": "flac",
        "inference_steps": 8, "batch_size": 1, "use_random_seed": True,
    }, timeout=120)
    task = (sub.get("data") or {}).get("task_id")
    if not task: raise RuntimeError("no task id: " + json.dumps(sub)[:200])
    t1 = time.time()
    audio_path = wait_for_result(task)
    audio = api(audio_path, raw=True, timeout=120)
    log("generated", len(audio), "bytes in", round(time.time() - t1), "s")
    if len(audio) < 20000: raise RuntimeError("audio too small")
    ctype = "audio/flac" if audio[:4] == b"fLaC" else "audio/mpeg"
    with open("song.flac" if ctype == "audio/flac" else "song.mp3", "wb") as f: f.write(audio)
    if not callback("audio", audio, ctype=ctype): raise RuntimeError("could not deliver the song")


if __name__ == "__main__":
    try:
        main()
    except Exception as e:
        log("FAILED", str(e)[:300])
        callback("error", message=str(e)[:250])
        sys.exit(1)

