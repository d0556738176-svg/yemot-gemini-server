// Read-only check of everything one download left in Yemot (owner, 19.11:
// one key press must give the phone file in the newest quality, extension 7,
// the best-quality copy in אודיו, and on "video" the file in וידאו).
// /branch2-saved?id=<id> answers what is really there, measured from the
// files themselves (ffprobe / ffmpeg volumedetect). Never writes; the
// account token is used only inside the server and never returned.
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

function run(bin, args, timeoutMs = 120000) {
  return new Promise(resolve => {
    const p = spawn(bin, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '', err = '';
    p.stdout.on('data', d => { out += d; if (out.length > 4e6) out = out.slice(-4e6); });
    p.stderr.on('data', d => { err = (err + d).slice(-20000); });
    const t = setTimeout(() => p.kill('SIGKILL'), timeoutMs);
    p.on('error', () => { clearTimeout(t); resolve({ code: -1, out, err }); });
    p.on('close', code => { clearTimeout(t); resolve({ code, out, err }); });
  });
}
const FFPROBE = ['/usr/bin/ffprobe', '/usr/local/bin/ffprobe'];
async function probe(fileOrUrl) {
  const bin = (await Promise.all(FFPROBE.map(async b => (await fs.stat(b).then(() => b).catch(() => null))))).find(Boolean) || 'ffprobe';
  const r = await run(bin, ['-v', 'error', '-show_streams', '-show_format', '-of', 'json', fileOrUrl], 60000);
  try {
    const j = JSON.parse(r.out);
    const a = (j.streams || []).find(s => s.codec_type === 'audio'), v = (j.streams || []).find(s => s.codec_type === 'video' && s.disposition?.attached_pic !== 1);
    return {
      container: j.format?.format_name || null, durationSec: Math.round(Number(j.format?.duration) || 0) || null, bitRate: Number(j.format?.bit_rate) || null,
      audio: a ? { codec: a.codec_name, sampleRate: Number(a.sample_rate), channels: a.channels, bits: Number(a.bits_per_raw_sample || a.bits_per_sample) || null } : null,
      video: v ? { codec: v.codec_name, width: v.width, height: v.height } : null,
      picture: (j.streams || []).some(s => s.disposition?.attached_pic === 1),
      subtitles: (j.streams || []).filter(s => s.codec_type === 'subtitle').map(s => s.tags?.language || s.codec_name),
      tags: Object.fromEntries(Object.entries(j.format?.tags || {}).map(([k, v]) => [k, String(v).replace(/\s+/g, ' ').slice(0, 140)])),
      pictureSize: (() => { const pic = (j.streams || []).find(s => s.disposition?.attached_pic === 1); return pic ? pic.width + 'x' + pic.height + ' ' + pic.codec_name : null; })(),
    };
  } catch { return { error: r.err.replace(/token=[^&\s]+/g, 'token=[x]').slice(-160) }; }
}

export async function savedReport(id, { p, ffmpegPath, lookupCached }) {
  const url = remote => { const u = new URL(p.YEMOT_API_BASE + '/DownloadFile'); u.searchParams.set('token', p.yemotApiKey()); u.searchParams.set('path', remote); return u.href; };
  const meta = async remote => { const m = await p.getYemotFile(remote).catch(() => null); return { exists: m?.file?.exists === true, size: Number(m?.file?.size) || 0 }; };
  const out = { id, at: new Date().toISOString() };
  // 1. The phone file (what extension 2 plays).
  const cached = await lookupCached(id).catch(() => null);
  const paths = cached?.playbackPaths || [];
  out.phone = { files: paths.length, paths: [] };
  for (const x of paths.slice(0, 3)) out.phone.paths.push({ path: x + '.wav', ...(await meta('ivr2:' + x + '.wav')) });
  if (paths[0]) {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'saved-'));
    try {
      const f = path.join(tmp, 'phone.wav');
      const r = await fetch(url('ivr2:' + paths[0] + '.wav'), { signal: AbortSignal.timeout(180000) });
      await fs.writeFile(f, Buffer.from(await r.arrayBuffer()));
      out.phone.probe = await probe(f);
      const v = await run(ffmpegPath, ['-hide_banner', '-nostats', '-i', f, '-af', 'volumedetect', '-f', 'null', '-'], 120000);
      const mx = v.err.match(/max_volume:\s*(-?[\d.]+) dB/), mean = v.err.match(/mean_volume:\s*(-?[\d.]+) dB/);
      out.phone.peakDb = mx ? Number(mx[1]) : null; out.phone.meanDb = mean ? Number(mean[1]) : null;
    } finally { await fs.rm(tmp, { recursive: true, force: true }).catch(() => {}); }
  }
  // 2. Extension 7.
  const idx = await p.readCacheJson('ivr2:/2/youtubeaudio/ext7_index.json').catch(() => null);
  const e7 = idx?.items?.[id];
  out.ext7 = e7 ? { file: e7.file, title: e7.title, ...(await meta('ivr2:/7/' + e7.file + '.wav')), newest: Number(e7.file) === Number(idx.next) - 1 } : null;
  // 3. The best-quality copy in אודיו (names owned by this id).
  const owners = await p.readCacheJson('ivr2:/2/youtubeaudio/download_owners.json').catch(() => null) || {};
  const names = Object.entries(owners).filter(([, v]) => v === id || v === id + '-he').map(([k]) => k);
  const folders = await p.readCacheJson('ivr2:/2/youtubeaudio/download_folders.json').catch(() => null) || {};
  out.audioCopy = [];
  const list = async dir => { const u = new URL(p.YEMOT_API_BASE + '/GetIVR2Dir'); u.searchParams.set('token', p.yemotApiKey()); u.searchParams.set('path', dir); const j = await (await fetch(u, { signal: AbortSignal.timeout(20000) })).json().catch(() => null); return (j?.files || []).map(f => f.name || f.what || ''); };
  if (names.length) {
    const n = Math.max(1, Number(folders.audio?.n) || 1);
    for (let k = n; k >= 1 && out.audioCopy.length < 4; k--) {
      const dir = k <= 1 ? 'ivr2:/אודיו' : 'ivr2:/אודיו_' + k;
      for (const f of await list(dir).catch(() => [])) {
        if (!names.some(nm => f.startsWith(nm) || f.startsWith(nm.split('__')[0] + '_חלק_'))) continue; // a long copy is saved in parts (_חלק_N)
        const remote = dir + '/' + f;
        out.audioCopy.push({ path: remote.replace(/^ivr2:/, ''), ...(await meta(remote)), probe: await probe(url(remote)) });
      }
    }
  }
  out.audioCopyNames = names;
  // 4. The video in וידאו.
  const vr = await p.readCacheJson('ivr2:/2/youtubejobs/' + Buffer.from(id).toString('hex') + '/video.json').catch(() => null);
  out.video = vr ? { state: vr.state, quality: vr.quality || null, subtitles: vr.subtitles || null, files: [] } : null;
  for (const f of (vr?.files || []).slice(0, 4)) out.video.files.push({ path: String(f.remote).replace(/^ivr2:/, ''), ...(await meta(f.remote)), probe: /\.mp4$/i.test(f.remote) ? await probe(url(f.remote)) : null });
  return out;
}

// Owner, 23.11: what the אודיו and וידאו folders in Yemot really hold, as the
// Yemot API lists them (count, newest names, sizes, the type Yemot gives each
// file). Read-only; no token or address is returned.
export async function foldersReport({ p, readFolders }) {
  const folders = (await readFolders().catch(() => null)) || {};
  const out = { at: new Date().toISOString(), folders: [] };
  const dirs = [];
  for (const [kind, base] of [['audio', 'אודיו'], ['video', 'וידאו']]) {
    const n = Math.max(1, Number(folders[kind]?.n) || 1);
    for (let k = 1; k <= n; k++) dirs.push(k <= 1 ? base : base + '_' + k);
  }
  for (const d of dirs) {
    const u = new URL(p.YEMOT_API_BASE + '/GetIVR2Dir'); u.searchParams.set('token', p.yemotApiKey()); u.searchParams.set('path', 'ivr2:/' + d);
    const j = await (await fetch(u, { signal: AbortSignal.timeout(30000) })).json().catch(e => ({ error: String(e?.message || e).slice(0, 80) }));
    const clean = o => Object.fromEntries(Object.entries(o || {}).filter(([k]) => !/token|key|pass|url/i.test(k)).map(([k, v]) => [k, typeof v === 'string' ? v.slice(0, 140) : v]));
    const files = Array.isArray(j?.files) ? j.files : [];
    const byExt = {};
    for (const f of files) { const e = String(f.name || '').split('.').pop().toLowerCase(); byExt[e] = (byExt[e] || 0) + 1; }
    out.folders.push({ dir: d, status: j?.responseStatus || null, message: j?.message ? String(j.message).slice(0, 120) : null, keys: Object.keys(j || {}).filter(k => !/token/i.test(k)),
      count: files.length, byExt, otherLists: Object.fromEntries(Object.entries(j || {}).filter(([k, v]) => Array.isArray(v) && k !== 'files').map(([k, v]) => [k, v.length])),
      newest: files.slice(-12).map(clean), first: files.slice(0, 3).map(clean) });
  }
  return out;
}
