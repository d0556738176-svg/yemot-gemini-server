// Read-only check of the whole-web search (18.11). Downloads go to /tmp only;
// nothing is uploaded to Yemot. Run with ext2's environment file.
import fs from 'node:fs';
import { execSync } from 'node:child_process';
const E = '/opt/yemot/ext2/';
// The console cannot type capitals, so ext2's settings are read here.
for (const line of fs.readFileSync('/opt/yemot/ext2.env', 'utf8').split('\n')) {
  const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
  if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^(['"])(.*)\1$/, '$2');
}
process.chdir('/opt/yemot/ext2');
const sh = c => { try { return execSync(c, { encoding: 'utf8' }).trim(); } catch (e) { return 'ERR ' + String(e.message).slice(0, 80); } };
const log = (...a) => console.log('[WV]', ...a);
log('services', sh('systemctl is-active yemot-main yemot-ext2 caddy | tr "\\n" " "'));
log('main head', sh('git -C /opt/yemot/main log --oneline -1'), 'running', sh('cat /opt/yemot/.running-main'));
log('ext2 head', sh('git -C /opt/yemot/ext2 log --oneline -1'), 'running', sh('cat /opt/yemot/.running-ext2'));
let host = ''; try { host = new URL(process.env.WEB_HINTS_URL || '').host; } catch {}
log('WEB_HINTS_URL host', host || '(not set)', 'secret set', !!process.env.WEB_HINTS_SECRET);
const wm = await import(E + 'web-media.js');
const yd = await import(E + 'youtube-direct.js');
const wi = await import(E + 'web-items.js');
const cov = await import(E + 'youtube-cover-art.js');
const facts = await import(E + 'youtube-video-facts.js');
const ff = (await import(E + 'node_modules/ffmpeg-static/index.js').catch(() => ({ default: 'ffmpeg' }))).default;
const picked = [];
for (const q of ['שיעור הרב גלינסקי', 'ניגון חסידי', 'שיעור פרשת השבוע']) {
  const t = Date.now();
  const c = await wm.webCandidates(q);
  log('candidates', JSON.stringify(q), c.length, 'sites', [...new Set(c.map(x => x.site))].slice(0, 12).join(','));
  const r = await wm.searchWebMedia(q, { candidates: c });
  log('found', JSON.stringify(q), 'web', r.items.length, 'youtube', r.youtube.length, 'checked', r.checked, 'sec', Math.round((Date.now() - t) / 1000));
  for (const it of r.items.slice(0, 6)) log('  item', it.id, it.site, it.durationSec, it.hasVideo ? 'video' : 'audio', it.impersonate ? 'imp' : '', String(it.title).slice(0, 60));
  for (const it of r.items) if (picked.length < 4 && !picked.some(p => p.site === it.site) && (it.durationSec || 0) < 3600) picked.push(it);
}
for (const url of ['https://soundcloud.com/shloimy-daskal/zol-shoin-kumen', 'https://www.dailymotion.com/video/x8j7k2w', 'https://www.kan.org.il/content/kan/podcasts/', 'https://www.yutorah.org/lectures/1108006/']) {
  const t = Date.now(); const it = await wm.inspectLink({ url }).catch(e => null);
  log('inspect', url.split('/')[2], it ? 'OK ' + it.site + ' ' + it.durationSec + 's ' + (it.impersonate ? 'imp ' : '') + String(it.title).slice(0, 50) : 'no media', Math.round((Date.now() - t) / 1000) + 's');
  if (it && picked.length < 6 && !picked.some(p => p.site === it.site) && (it.durationSec || 0) < 3600) picked.push(it);
}
for (const it of picked) {
  const out = '/tmp/wv-' + it.id + '.m4a', t = Date.now();
  try {
    const r = await yd.directDownload(it.id, out, { mode: 'audio', ffmpegPath: ff, maxBytes: 400e6, signal: AbortSignal.timeout(240000), withCaptions: false, log: { warn() {}, info() {} } });
    const f = await facts.fetchVideoFacts(it.id);
    const m = cov.downloadMetadata(it.id, f);
    const c = await cov.coverFor(it.id, { ffmpegPath: ff }).catch(() => null);
    log('download audio', it.site, 'bytes', r.bytes, 'sec', Math.round((Date.now() - t) / 1000), 'website', m.website === it.url, 'publisher', m.publisher, 'cover', c ? c.length : 0);
  } catch (e) { log('download audio FAIL', it.site, e.code || '', String(e.message).slice(0, 120)); }
  fs.rmSync(out, { force: true });
}
const v = picked.find(x => x.hasVideo);
if (v) {
  const out = '/tmp/wv-v.mp4', t = Date.now();
  try { const r = await yd.directDownload(v.id, out, { mode: 'video', height: 480, ffmpegPath: ff, maxBytes: 600e6, signal: AbortSignal.timeout(300000), withCaptions: false, log: { warn() {}, info() {} } }); log('download video', v.site, 'bytes', r.bytes, 'sec', Math.round((Date.now() - t) / 1000)); }
  catch (e) { log('download video FAIL', v.site, e.code || '', String(e.message).slice(0, 120)); }
  fs.rmSync(out, { force: true });
}
log('done');
process.exit(0);
