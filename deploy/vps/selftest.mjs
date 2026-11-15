// Whole-server check, run on the Empire server:
//   node /opt/yemot/main/deploy/vps/selftest.mjs
// Prints one PASS/FAIL line per part. Never prints keys or links with secrets.
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { synthesize } from '../../edge-tts.js';
import { copyFileSync, statSync, mkdtempSync, existsSync } from 'node:fs';
const EXT2 = '/opt/yemot/ext2';

const env = {};
for (const f of ['/opt/yemot/main.env', '/opt/yemot/ext2.env']) {
  for (const line of readFileSync(f, 'utf8').split('\n')) {
    const m = line.match(/^([A-Z0-9_]+)="(.*)"$/); if (m && !(m[1] in env)) env[m[1]] = m[2].replace(/\\"/g, '"').replace(/\\\\/g, '\\');
  }
}
const results = [];
async function check(name, fn) {
  const t = Date.now();
  try { const info = await fn(); results.push(true); console.log('PASS', name, (Date.now() - t) + 'ms', info || ''); }
  catch (e) { results.push(false); console.log('FAIL', name, String(e?.message || e).slice(0, 160)); }
}
const get = (url, opts = {}) => fetch(url, { signal: AbortSignal.timeout(20000), ...opts });

await check('main app', async () => { const r = await get('http://127.0.0.1:3000/'); if (r.status >= 500) throw new Error('HTTP ' + r.status); return 'HTTP ' + r.status; });
await check('ext2 app', async () => { const r = await get('http://127.0.0.1:3001/'); if (r.status >= 500) throw new Error('HTTP ' + r.status); return 'HTTP ' + r.status; });
await check('course builder', async () => { const r = await get('http://127.0.0.1:3002/'); return 'HTTP ' + r.status; });
for (const h of ['main', 'ext2']) {
  await check('https ' + h, async () => {
    const base = h === 'main' ? env.PUBLIC_BASE_URL : env.EXT2_MEDIA_URL;
    const r = await get(base + '/'); if (r.status >= 500) throw new Error('HTTP ' + r.status); return base + ' HTTP ' + r.status;
  });
}
await check('main -> ext2 media link', async () => {
  const r = await get(env.EXT2_MEDIA_URL + '/api/ext3/youtube/status?videoId=jNQXAC9IVRw'); return 'HTTP ' + r.status;
});
const fileEnv = f => Object.fromEntries(readFileSync(f, 'utf8').split('\n').map(l => l.match(/^([A-Z0-9_]+)="(.*)"$/)).filter(Boolean).map(m => [m[1], m[2]]));
for (const f of ['main', 'ext2']) {
  const e = fileEnv('/opt/yemot/' + f + '.env');
  const cands = { YEMOT_API_KEY: e.YEMOT_API_KEY, YEMOT_TOKEN: e.YEMOT_TOKEN, 'USERNAME:PASSWORD': e.YEMOT_API_USERNAME && e.YEMOT_API_PASSWORD ? e.YEMOT_API_USERNAME + ':' + e.YEMOT_API_PASSWORD : '' };
  for (const [name, token] of Object.entries(cands)) {
    if (!token) { console.log('     ', f, name, 'not set'); continue; }
    await check('yemot login ' + f + ' ' + name, async () => {
      const j = await (await get('https://www.call2all.co.il/ym/api/GetTextFile?' + new URLSearchParams({ token, what: 'ivr2:/4/ext.ini' }))).json();
      if (j.responseStatus !== 'OK') throw new Error(String(j.message || j.responseStatus));
      return 'extension 4 -> ' + ((String(j.contents).match(/api_link=(\S+)/) || [])[1] || '').replace(/[?#].*/, '');
    });
  }
}
const tmp = mkdtempSync('/tmp/selftest-');
const ytdlp = existsSync('/usr/local/bin/yt-dlp') ? '/usr/local/bin/yt-dlp' : EXT2 + '/node_modules/youtube-dl-exec/bin/yt-dlp';
const ffmpegPath = (await import(EXT2 + '/node_modules/ffmpeg-static/index.js')).default;
await check('youtube search (yt-dlp from this server)', async () => {
  const r = spawnSync(ytdlp, ['--no-warnings', '--flat-playlist', '--print', '%(id)s', 'ytsearch3:שיר חסידי'], { timeout: 90000, encoding: 'utf8' });
  if (r.status !== 0) throw new Error((r.stderr || 'exit ' + r.status).split('\n').filter(Boolean).pop());
  return r.stdout.trim().split('\n').length + ' results';
});
const { directDownload } = await import(EXT2 + '/youtube-direct.js');
await check('youtube audio, direct (as extension 2 does it)', async () => {
  const r = await directDownload('jNQXAC9IVRw', tmp + '/zoo.m4a', { mode: 'audio', ffmpegPath, log: { info() {}, warn: m => console.log('  try failed', JSON.stringify(m).slice(0, 160)) } });
  return r.bytes + ' bytes, player ' + (r.client || 'default');
});
await check('youtube video, direct (as extension 2 does it)', async () => {
  const r = await directDownload('jNQXAC9IVRw', tmp + '/zoo.mp4', { mode: 'video', height: 720, ffmpegPath, log: { info() {}, warn: m => console.log('  try failed', JSON.stringify(m).slice(0, 160)) } });
  return r.bytes + ' bytes, player ' + (r.client || 'default');
});
await check('hebrew dubbing, whole chain (key 9; nothing is published)', async () => {
  for (const [k, v] of Object.entries(env)) if (!(k in process.env)) process.env[k] = v;
  const { dubToHebrew } = await import(EXT2 + '/youtube-dub.js');
  let published = null;
  const deps = {
    ffmpegPath,
    fetchSource: async (id, dest) => { try { copyFileSync(tmp + '/zoo.m4a', dest); } catch { copyFileSync(tmp + '/zoo.mp4', dest); } },
    preparePhone: async (src, dest) => copyFileSync(src, dest),
    publishExt7: async (name, file) => { published = statSync(file).size; return { file: 'test' }; },
    saveDownload: async () => {},
  };
  const quiet = { info: () => {}, warn: m => console.log('  warn', m), error: m => console.log('  error', m) };
  const r = await dubToHebrew({ videoId: 'jNQXAC9IVRw', title: 'test' }, deps, { env: process.env, log: quiet });
  if (r.state !== 'done' || !published) throw new Error('state ' + r.state);
  return 'dubbed sound ' + published + ' bytes';
});
for (const k of Object.keys(env).filter(k => /^APIFY_TOKEN/.test(k)).sort()) {
  await check('apify (extension 2 download engine) ' + k, async () => {
    const j = await (await get('https://api.apify.com/v2/users/me/limits', { headers: { Authorization: 'Bearer ' + env[k] } })).json();
    if (!j.data) throw new Error(JSON.stringify(j.error || j).slice(0, 120));
    const used = j.data.current?.monthlyUsageUsd, max = j.data.limits?.maxMonthlyUsageUsd;
    if (used >= max) throw new Error('monthly credit used up: ' + used + ' of ' + max + ' USD');
    return 'used ' + (+used).toFixed(2) + ' of ' + max + ' USD this month';
  });
}
await check('hebrew speech (edge tts)', async () => {
  const buf = await synthesize('בדיקה של הדיבור בעברית', { voice: 'he-IL-AvriNeural' });
  if (!buf || buf.length < 2000) throw new Error('empty audio'); return buf.length + ' bytes';
});
await check('song engine (github dispatch token)', async () => {
  if (!env.GITHUB_DISPATCH_TOKEN) throw new Error('GITHUB_DISPATCH_TOKEN missing');
  const r = await get('https://api.github.com/repos/d0556738176-svg/yemot-gemini-server/actions/workflows', { headers: { Authorization: 'Bearer ' + env.GITHUB_DISPATCH_TOKEN, Accept: 'application/vnd.github+json' } });
  if (!r.ok) throw new Error('GitHub HTTP ' + r.status); const j = await r.json();
  return (j.workflows || []).some(w => /song-worker/.test(w.path)) ? 'song workflow found' : 'song workflow NOT found';
});
console.log('yt-dlp version', spawnSync(ytdlp, ['--version'], { encoding: 'utf8' }).stdout.trim());
for (const [name, key] of [['groq', 'GROQ_API_KEY'], ['gemini', 'GEMINI_API_KEY'], ['rapidapi', 'RAPIDAPI_KEY']]) {
  await check('key present: ' + name, async () => { if (!Object.keys(env).some(k => k.startsWith(key))) throw new Error('missing'); });
}
const disk = spawnSync('df', ['-h', '--output=pcent', '/'], { encoding: 'utf8' }).stdout.split('\n')[1]?.trim();
console.log('disk used', disk);
console.log(results.every(Boolean) ? 'ALL-PASS' : 'SOME-FAILED', results.filter(Boolean).length + '/' + results.length);
