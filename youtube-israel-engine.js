// Videos YouTube allows only in Israel (owner, 13.11: "solve it at the root").
// Our main engine (johnvc) runs outside Israel with no country option, and the
// store engines tested live on 13.11 all failed for such a video (403, no
// Israel in their country list, or a full-account-access demand). So this is
// our own small Apify engine: yt-dlp downloading through Apify's residential
// (home) connection in Israel, a sticky session so YouTube sees one Israeli
// address for the page and the file, the exit country verified before every
// attempt, up to 4 attempts on fresh Israeli addresses. It lives in each of
// the owner's Apify accounts (every key), is created/updated by the server, and
// is used ONLY for videos that are limited to Israel (cost: Apify compute +
// residential traffic, about $8/GB: ~1 MB per minute of audio).
import { createHash } from 'node:crypto';

const API = 'https://api.apify.com/v2';
export const ISRAEL_ACTOR_NAME = 'yemot-israel-downloader';
const VERSION = '0.1';

const DOCKERFILE = `FROM apify/actor-python:3.12
USER root
RUN apt-get update && apt-get install -y --no-install-recommends ffmpeg curl unzip ca-certificates \\
 && rm -rf /var/lib/apt/lists/* \\
 && curl -fsSL https://github.com/denoland/deno/releases/latest/download/deno-x86_64-unknown-linux-gnu.zip -o /tmp/deno.zip \\
 && unzip -o /tmp/deno.zip -d /usr/local/bin && rm /tmp/deno.zip && deno --version
RUN pip install --no-cache-dir -U "yt-dlp[default]" apify requests
COPY . ./
CMD ["python3", "main.py"]
`;

const MAIN_PY = `import os, json, glob, time, hashlib, subprocess, asyncio
import requests
from apify import Actor

API = 'https://api.apify.com/v2'
CTYPES = {'m4a': 'audio/mp4', 'webm': 'audio/webm', 'mp4': 'video/mp4', 'opus': 'audio/ogg', 'mp3': 'audio/mpeg', 'mkv': 'video/x-matroska'}

async def main():
    async with Actor:
        inp = await Actor.get_input() or {}
        vid = str(inp.get('videoId', ''))
        mode = 'video' if inp.get('mode') == 'video' else 'audio'
        country = str(inp.get('country') or 'IL').upper()
        max_h = int(inp.get('maxHeight') or 720)
        token = os.environ.get('APIFY_TOKEN', '')
        store = os.environ.get('ACTOR_DEFAULT_KEY_VALUE_STORE_ID', '')
        url = 'https://www.youtube.com/watch?v=' + vid
        last = ''
        files = []
        for attempt in range(4):
            pc = await Actor.create_proxy_configuration(groups=['RESIDENTIAL'], country_code=country)
            session = ('yt' + ''.join(c for c in vid if c.isalnum()) + str(attempt) + str(int(time.time()) % 100000))[:48]
            purl = await pc.new_url(session_id=session)
            proxies = {'https': purl, 'http': purl}
            try:
                ip = requests.get('https://ipinfo.io/json', proxies=proxies, timeout=25).json()
                Actor.log.info('exit address country=%s city=%s org=%s' % (ip.get('country'), ip.get('city'), ip.get('org')))
                if ip.get('country') != country:
                    last = 'exit country ' + str(ip.get('country'))
                    continue
            except Exception as e:
                last = 'proxy check failed: ' + str(e)[:200]
                Actor.log.warning(last)
                continue
            for f in glob.glob('/tmp/out.*'):
                os.remove(f)
            if mode == 'audio':
                fmt = 'bestaudio[ext=m4a]/bestaudio'
                extra = []
            else:
                fmt = 'bv*[height<=%d][ext=mp4]+ba[ext=m4a]/b[height<=%d][ext=mp4]/bv*[height<=%d]+ba/b' % (max_h, max_h, max_h)
                extra = ['--merge-output-format', 'mp4']
            cmd = ['yt-dlp', '--proxy', purl, '-f', fmt, *extra, '-o', '/tmp/out.%(ext)s', '--no-playlist', '--no-progress',
                   '--retries', '5', '--fragment-retries', '10', '--socket-timeout', '30', '--write-info-json', url]
            p = subprocess.run(cmd, capture_output=True, text=True, timeout=3300)
            Actor.log.info('yt-dlp exit %s: %s' % (p.returncode, (p.stderr or '')[-1500:]))
            files = [f for f in glob.glob('/tmp/out.*') if not f.endswith('.json') and not f.endswith('.part') and not f.endswith('.ytdl')]
            if p.returncode == 0 and files:
                break
            last = ((p.stderr or '') + (p.stdout or ''))[-700:]
            files = []
        if not files:
            await Actor.push_data({'videoId': vid, 'status': 'failed', 'error': last[-500:]})
            await Actor.fail(status_message=('Israel download failed: ' + last)[-250:])
            return
        path = files[0]
        ext = path.rsplit('.', 1)[1]
        key = vid + '.' + ext
        ctype = CTYPES.get(ext, 'application/octet-stream')
        size = os.path.getsize(path)
        h = hashlib.sha256()
        with open(path, 'rb') as fh:
            for chunk in iter(lambda: fh.read(1 << 20), b''):
                h.update(chunk)
        with open(path, 'rb') as fh:
            r = requests.put('%s/key-value-stores/%s/records/%s' % (API, store, key), data=fh,
                             headers={'Content-Type': ctype, 'Authorization': 'Bearer ' + token}, timeout=3000)
            r.raise_for_status()
        info = {}
        try:
            info = json.load(open('/tmp/out.info.json'))
        except Exception:
            pass
        await Actor.push_data({'videoId': vid, 'status': 'ok', 'mode': mode, 'title': info.get('title'),
                               'durationSeconds': info.get('duration'), 'fileSizeBytes': size, 'sha256': h.hexdigest(),
                               'ext': ext, 'contentType': ctype, 'exitCountry': country,
                               'downloadUrl': '%s/key-value-stores/%s/records/%s' % (API, store, key)})

asyncio.run(main())
`;

const ACTOR_JSON = JSON.stringify({ actorSpecification: 1, name: ISRAEL_ACTOR_NAME, version: VERSION, buildTag: 'latest', dockerfile: '../Dockerfile' }, null, 2);

export const ISRAEL_ACTOR_FILES = [
  { name: 'Dockerfile', format: 'TEXT', content: DOCKERFILE },
  { name: 'main.py', format: 'TEXT', content: MAIN_PY },
  { name: 'requirements.txt', format: 'TEXT', content: 'apify\nrequests\nyt-dlp[default]\n' },
  { name: '.actor/actor.json', format: 'TEXT', content: ACTOR_JSON },
];
export const ISRAEL_ACTOR_SOURCE_HASH = createHash('sha256').update(JSON.stringify(ISRAEL_ACTOR_FILES)).digest('hex').slice(0, 16);

async function api(token, path, init = {}) {
  const r = await fetch(API + path, { ...init, headers: { authorization: 'Bearer ' + token, 'content-type': 'application/json', ...(init.headers || {}) }, signal: AbortSignal.timeout(init.timeoutMs || 90000) });
  const text = await r.text();
  let j = null; try { j = JSON.parse(text); } catch { /* text */ }
  if (!r.ok) throw Object.assign(new Error('apify ' + r.status + ' ' + text.slice(0, 300)), { status: r.status });
  return j ?? text;
}

// The actor in this account, created or updated to the current source, with
// a successful build. Returns its id. The source hash is kept in the actor's
// description so an unchanged engine is never rebuilt.
const ready = new Map();
export async function ensureIsraelActor(token, { log = console } = {}) {
  if (ready.get(token)) return ready.get(token);
  const mine = await api(token, '/acts?my=1&limit=1000');
  let act = (mine.data?.items || []).find(a => a.name === ISRAEL_ACTOR_NAME);
  const marker = 'source ' + ISRAEL_ACTOR_SOURCE_HASH;
  const version = { versionNumber: VERSION, sourceType: 'SOURCE_FILES', buildTag: 'latest', sourceFiles: ISRAEL_ACTOR_FILES };
  let needBuild = false;
  if (!act) {
    act = (await api(token, '/acts', { method: 'POST', body: JSON.stringify({ name: ISRAEL_ACTOR_NAME, isPublic: false, description: 'Yemot: downloads videos limited to Israel through an Israeli residential connection. ' + marker, versions: [version], defaultRunOptions: { build: 'latest', memoryMbytes: 1024, timeoutSecs: 3600 } }) })).data;
    needBuild = true;
    log.info?.('[ISRAEL_ENGINE] engine created in this account', { actorId: act.id });
  } else {
    const full = (await api(token, '/acts/' + act.id)).data;
    if (!String(full.description || '').includes(marker)) {
      await api(token, '/acts/' + act.id + '/versions/' + VERSION, { method: 'PUT', body: JSON.stringify(version) }).catch(async e => {
        if (e.status === 404) await api(token, '/acts/' + act.id + '/versions', { method: 'POST', body: JSON.stringify(version) }); else throw e;
      });
      await api(token, '/acts/' + act.id, { method: 'PUT', body: JSON.stringify({ description: 'Yemot: downloads videos limited to Israel through an Israeli residential connection. ' + marker }) });
      needBuild = true;
      log.info?.('[ISRAEL_ENGINE] engine source updated', { actorId: act.id });
    } else {
      const builds = await api(token, '/acts/' + act.id + '/builds?desc=1&limit=5');
      needBuild = !(builds.data?.items || []).some(b => b.status === 'SUCCEEDED');
    }
  }
  if (needBuild) {
    let b = (await api(token, '/acts/' + act.id + '/builds?version=' + VERSION + '&tag=latest&waitForFinish=60', { method: 'POST' })).data;
    for (let i = 0; i < 60 && !['SUCCEEDED', 'FAILED', 'ABORTED', 'TIMED-OUT'].includes(b.status); i++) {
      await new Promise(r => setTimeout(r, 10000));
      b = (await api(token, '/actor-builds/' + b.id)).data;
    }
    if (b.status !== 'SUCCEEDED') {
      const blog = String(await api(token, '/logs/' + b.id).catch(() => '')).slice(-1500);
      throw Object.assign(new Error('Israel engine build ' + b.status + ': ' + blog), { code: 'israel_build_failed' });
    }
    log.info?.('[ISRAEL_ENGINE] engine built', { actorId: act.id, buildId: b.id });
  }
  ready.set(token, act.id);
  return act.id;
}

export function israelRunInput(videoId, mode = 'audio') {
  return { videoId, mode: mode === 'video' ? 'video' : 'audio', country: 'IL', maxHeight: 720 };
}

// The symbolic engine name used in receipts and engine choice; each account
// has its own copy of the actor, so the real id is resolved per key.
export const ISRAEL_ACTOR = 'own~yemot-israel-downloader';
export async function actorIdFor(actor, token, opts) {
  return actor === ISRAEL_ACTOR ? ensureIsraelActor(token, opts) : actor;
}
