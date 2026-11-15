// Direct download test on Israel-only videos (as extension 2 downloads them).
//   node deploy/vps/israel-check.mjs
import { mkdtempSync, rmSync } from 'node:fs';
const EXT2 = '/opt/yemot/ext2';
const { directDownload } = await import(EXT2 + '/youtube-direct.js');
const ffmpegPath = (await import(EXT2 + '/node_modules/ffmpeg-static/index.js')).default;
const tmp = mkdtempSync('/tmp/iltest-');
const ids = ['SGbRCbhWK_8', 'HHkeMlB4yNI', 'FWx3ZbgLtR0', 'O-lvBFC5S0A', 'Z2Uq4aX2KPs'];
let ok = 0, n = 0;
const run = async (id, mode) => {
  n++; const t = Date.now();
  try {
    const r = await directDownload(id, tmp + '/' + id + (mode === 'video' ? '.mp4' : '.m4a'), { mode, height: 720, ffmpegPath, log: { info() {}, warn: m => console.log('   try failed', m.client, String(m.message).slice(0, 90)) } });
    ok++; console.log('PASS', mode, id, (r.bytes / 1048576).toFixed(1) + 'MB', Math.round((Date.now() - t) / 1000) + 's', 'player', r.client || 'default', String(r.title || '').slice(0, 40));
  } catch (e) { console.log('FAIL', mode, id, String(e.message).slice(0, 120)); }
};
for (const id of ids) await run(id, 'audio');
await run(ids[0], 'video');
await run(ids[1], 'video');
rmSync(tmp, { recursive: true, force: true });
console.log(ok === n ? 'ALL-PASS' : 'SOME-FAILED', ok + '/' + n);
