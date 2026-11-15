// Download folders in Yemot: how many files each has, and the switch point.
//   node deploy/vps/folders-check.mjs
import { readFileSync } from 'node:fs';
const env = Object.fromEntries(readFileSync('/opt/yemot/ext2.env', 'utf8').split('\n').map(l => l.match(/^([A-Z0-9_]+)="(.*)"$/)).filter(Boolean).map(m => [m[1], m[2]]));
const token = env.YEMOT_API_USERNAME + ':' + env.YEMOT_API_PASSWORD;
const API = 'https://www.call2all.co.il/ym/api/';
const get = async (m, p) => (await fetch(API + m + '?' + new URLSearchParams({ token, ...p }), { signal: AbortSignal.timeout(30000) })).json();
const idx = await get('GetTextFile', { what: 'ivr2:/2/youtubeaudio/download_folders.json' }).catch(() => null);
let counters = {}; try { counters = JSON.parse(idx?.contents || '{}'); } catch {}
console.log('counter file', JSON.stringify(counters), '(new folder after 2900 files)');
for (const base of ['אודיו', 'וידאו']) {
  for (let n = 1; n <= 5; n++) {
    const path = 'ivr2:/' + (n === 1 ? base : base + '_' + n);
    const j = await get('GetIVR2Dir', { path }).catch(e => ({ responseStatus: 'ERR', message: e.message }));
    if (j.responseStatus !== 'OK') { if (n === 1) console.log(path, 'not found:', j.message || j.responseStatus); break; }
    const files = j.files || [];
    const newest = files.map(f => f.mtime || f.date || '').sort().pop() || '';
    console.log(path, files.length, 'files', newest ? 'newest ' + newest : '');
  }
}
