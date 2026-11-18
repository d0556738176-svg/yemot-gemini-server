// READ-ONLY capability probe: which sites this server can take audio/video
// from, with what quality, and how fast. Writes only under /tmp, deletes it.
//   node site-probe.mjs
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, statSync, readdirSync, existsSync } from 'node:fs';
const Y = existsSync('/usr/local/bin/yt-dlp') ? '/usr/local/bin/yt-dlp' : '/opt/yemot/ext2/node_modules/youtube-dl-exec/bin/yt-dlp';
const FF = '/opt/yemot/ext2/node_modules/ffmpeg-static/ffmpeg';
const run = (cmd, args, t = 90000) => spawnSync(cmd, args, { encoding: 'utf8', timeout: t, maxBuffer: 64 * 1024 * 1024, env: { ...process.env, PATH: process.env.PATH + ':/usr/local/bin' } });
const line = s => console.log(s);

line('== TOOLS');
line('yt-dlp ' + run(Y, ['--version']).stdout.trim() + ' | extractors: ' + run(Y, ['--list-extractors']).stdout.split('\n').filter(Boolean).length);
const imp = run(Y, ['--list-impersonate-targets']).stdout.split('\n').filter(l => /chrome|safari|firefox|edge/i.test(l) && !/unavailable/i.test(l)).length;
line('browser impersonation targets available: ' + imp);
const ffv = run(FF, ['-hide_banner', '-version']).stdout.split('\n')[0];
const enc = run(FF, ['-hide_banner', '-encoders']).stdout;
line(ffv.slice(0, 60) + ' | encoders: ' + ['libmp3lame', 'libopus', 'aac', 'flac', 'libx264', 'libx265', 'libvpx-vp9', 'libaom-av1', 'libsvtav1'].filter(e => enc.includes(' ' + e + ' ')).join(','));
for (const t of ['aria2c', 'gallery-dl', 'deno', 'python3', 'streamlink', 'wget', 'curl', 'chromium', 'google-chrome']) line('  ' + t.padEnd(14) + (run('sh', ['-c', 'command -v ' + t]).stdout.trim() || '-'));
line('CPU ' + run('nproc', []).stdout.trim() + ' cores | ' + run('sh', ['-c', 'free -h | sed -n 2p']).stdout.trim() + ' | disk ' + run('sh', ['-c', "df -h / | tail -1 | awk '{print $4\" free of \"$2}'"]).stdout.trim());

line('== NETWORK SPEED (12.5 MB test file)');
const sp = run('curl', ['-s', '-o', '/dev/null', '-w', '%{speed_download} %{time_total}', 'https://proof.ovh.net/files/100Mb.dat'], 120000).stdout.split(' ');
line('download ' + (Number(sp[0]) * 8 / 1e6).toFixed(0) + ' Mbit/s in ' + Number(sp[1]).toFixed(1) + 's');

const SITES = [
  ['YouTube', 'https://www.youtube.com/watch?v=jNQXAC9IVRw'],
  ['YouTube Music', 'https://music.youtube.com/watch?v=jNQXAC9IVRw'],
  ['YouTube playlist', 'https://www.youtube.com/playlist?list=PLbpi6ZahtOH6Ar_3GPy3workvQ3YYrjv7'],
  ['Hidabroot shiur', 'https://www.hidabroot.org/video/227139'],
  ['YUTorah shiur', 'https://www.yutorah.org/lectures/867407/'],
  ['Kan radio', 'https://www.kan.org.il/radio/player.aspx?ItemId=130134'],
  ['Vimeo', 'https://vimeo.com/76979871'],
  ['SoundCloud', 'https://soundcloud.com/forss/flickermood'],
  ['Bandcamp', 'https://yt-dlp.bandcamp.com/track/youtube-dl-test-song'],
  ['Archive.org', 'https://archive.org/details/Popeye_forPresident'],
  ['Dailymotion', 'https://www.dailymotion.com/video/x5kesuj'],
  ['TikTok', 'https://www.tiktok.com/@leenabhushan/video/6748451240264420610'],
  ['Facebook', 'https://www.facebook.com/watch/?v=274175099429670'],
  ['Instagram', 'https://www.instagram.com/p/aye83DjauH/'],
  ['X / Twitter', 'https://x.com/freethenipple/status/643211948184596480'],
  ['Spotify', 'https://open.spotify.com/track/4uLU6hMCjMI75M1A2tKUQC'],
  ['Direct MP3 link', 'https://www.soundhelix.com/examples/mp3/SoundHelix-Song-1.mp3'],
  ['HLS stream (m3u8)', 'https://test-streams.mux.dev/x36xhzz/x36xhzz.m3u8'],
];
line('== SITES (metadata only, nothing downloaded)');
const ok = [];
for (const [name, url] of SITES) {
  const r = run(Y, ['--no-warnings', '--dump-single-json', '--flat-playlist', '--no-check-certificates', '--socket-timeout', '20', url], 90000);
  if (r.status !== 0) { line('FAIL ' + name.padEnd(18) + ((r.stderr || r.error?.message || 'timeout').trim().split('\n').pop() || '').replace(/https?:\/\/\S+/g, '').slice(0, 110)); continue; }
  let j; try { j = JSON.parse(r.stdout); } catch { line('FAIL ' + name.padEnd(18) + 'bad answer'); continue; }
  if (j._type === 'playlist') { line('OK   ' + name.padEnd(18) + 'playlist, ' + (j.entries || []).length + ' items | ' + String(j.title || '').slice(0, 40)); continue; }
  const f = j.formats || [];
  const a = f.filter(x => x.acodec && x.acodec !== 'none').sort((x, y) => (y.abr || y.tbr || 0) - (x.abr || x.tbr || 0))[0];
  const v = f.filter(x => x.vcodec && x.vcodec !== 'none').sort((x, y) => (y.height || 0) - (x.height || 0))[0];
  line('OK   ' + name.padEnd(18) + '[' + j.extractor_key + '] ' + String(j.title || '').slice(0, 34).padEnd(34) + ' ' + (j.duration ? Math.round(j.duration) + 's' : '') +
    ' | audio ' + (a ? (a.acodec || '?') + ' ' + Math.round(a.abr || a.tbr || 0) + 'k' : '-') + ' | video ' + (v ? (v.height || '?') + 'p ' + String(v.vcodec || '').split('.')[0] : '-') + ' | ' + f.length + ' formats' + (j.subtitles && Object.keys(j.subtitles).length ? ' | subs ' + Object.keys(j.subtitles).slice(0, 4).join(',') : ''));
  ok.push([name, url]);
}
line('== REAL DOWNLOADS (to /tmp, deleted after)');
const d = mkdtempSync('/tmp/probe-');
for (const [name, url, mode] of [['SoundCloud', 'https://soundcloud.com/forss/flickermood', 'a'], ['Vimeo', 'https://vimeo.com/76979871', 'v'], ['Hidabroot shiur', 'https://www.hidabroot.org/video/227139', 'a'], ['Archive.org', 'https://archive.org/details/Popeye_forPresident', 'v'], ['HLS stream (m3u8)', 'https://test-streams.mux.dev/x36xhzz/x36xhzz.m3u8', 'v']]) {
  if (!ok.find(x => x[0] === name)) { line('skip ' + name); continue; }
  const out = d + '/' + name.replace(/\W+/g, '_');
  const t = Date.now();
  const r = run(Y, ['--no-warnings', '-q', '--ffmpeg-location', FF, '-N', '4', ...(mode === 'a' ? ['-f', 'bestaudio/best', '-x', '--audio-format', 'flac'] : ['-f', 'bv*[height<=1080]+ba/b', '--merge-output-format', 'mp4']), '--embed-metadata', '--embed-thumbnail', '-o', out + '.%(ext)s', url], 600000);
  const files = readdirSync(d).filter(n => n.startsWith(name.replace(/\W+/g, '_')));
  const bytes = files.reduce((s, n) => s + statSync(d + '/' + n).size, 0);
  line((r.status === 0 && bytes ? 'OK   ' : 'FAIL ') + name.padEnd(18) + (mode === 'a' ? 'audio->FLAC ' : 'video mp4 ') + (bytes / 1048576).toFixed(1) + 'MB in ' + Math.round((Date.now() - t) / 1000) + 's ' + (r.status ? (r.stderr || '').trim().split('\n').pop().slice(0, 80) : files.join(',')));
}
rmSync(d, { recursive: true, force: true });
line('== DONE');
