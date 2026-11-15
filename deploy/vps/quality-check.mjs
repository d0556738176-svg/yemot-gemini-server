// Download quality and captions, as extension 2 does it, on this server.
//   node deploy/vps/quality-check.mjs [videoId]
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
const EXT2 = '/opt/yemot/ext2';
const id = process.argv[2] || 'jNQXAC9IVRw';
const { directDownload } = await import(EXT2 + '/youtube-direct.js');
const ff = (await import(EXT2 + '/node_modules/ffmpeg-static/index.js')).default;
const d = mkdtempSync('/tmp/q-');
const quiet = { info: m => console.log('  ', JSON.stringify(m).slice(0, 150)), warn: m => console.log('  warn', JSON.stringify(m).slice(0, 150)) };
const probe = f => { try { execFileSync(ff, ['-hide_banner', '-i', f], { stdio: ['ignore', 'pipe', 'pipe'] }); } catch (e) { return String(e.stderr).split('\n').filter(l => /Stream|language|Duration/.test(l)).map(l => l.trim().slice(0, 110)).join('\n   '); } };
const a = await directDownload(id, d + '/source', { mode: 'audio', ffmpegPath: ff, log: quiet });
console.log('AUDIO', a.bytes, 'bytes, captions:', a.captions.join(',') || 'none', '| lyrics file:', existsSync(d + '/source.lyrics.txt') ? readFileSync(d + '/source.lyrics.txt', 'utf8').split('\n').length + ' lines' : 'no');
console.log('  ', probe(d + '/source'));
const v = await directDownload(id, d + '/v.mp4', { mode: 'video', height: 1080, ffmpegPath: ff, log: quiet });
console.log('VIDEO', v.bytes, 'bytes, captions:', v.captions.join(',') || 'none');
console.log('  ', probe(d + '/v.mp4'));
rmSync(d, { recursive: true, force: true });
