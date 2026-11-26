// Owner, 27.11: key 2 on a file playing in extension 7 deletes it from the
// whole system (after 1 = yes / 2 = cancel):
//   - the file in extension 7 and its line in the list (ext7_index.json),
//     which is also the AI extensions' list of saved songs (1 and 3), so the
//     AI no longer knows it or plays it;
//   - the saved phone copy of the video (ivr2:/2/youtubeaudio/<id>), so
//     nothing plays it again without a new download;
//   - its copies in the downloads folders: אודיו (and אודיו_2...), וידאו
//     (and וידאו_2...), and for an AI song (extension 4) "שירי AI" too;
//   - its lines in the downloads owners list.
// A Hebrew-dubbed copy is a separate file: deleting one keeps the other.
export const INDEX = 'ivr2:/2/youtubeaudio/ext7_index.json';
export const OWNERS = 'ivr2:/2/youtubeaudio/download_owners.json';
export const FOLDER_BASES = { audio: 'ivr2:/אודיו', video: 'ivr2:/וידאו', ai: 'ivr2:/שירי AI' };
const MAX_FOLDERS = 30;

const stem = n => String(n).replace(/\.[^.]+$/, '');
export const cacheDirOf = key => 'ivr2:/2/youtubeaudio/' + Buffer.from(String(key), 'utf8').toString('hex');

// Every numbered folder of a kind that exists (אודיו, אודיו_2, ...).
async function folders(base, io) {
  const out = [];
  for (let n = 1; n <= MAX_FOLDERS; n++) {
    const dir = n === 1 ? base : base + '_' + n;
    const names = await io.list(dir).catch(() => null);
    if (names === null) { if (n > 2) break; continue; }
    out.push({ dir, names });
  }
  return out;
}

// Does a file name belong to one of these saved names (also "_Chelek_N" parts)?
export function belongs(fileName, names) {
  const s = stem(fileName);
  for (const n of names) {
    if (!n) continue;
    if (s === n || s.startsWith(n + '_Chelek_')) return true;
    const i = n.indexOf('__');
    if (i >= 0 && new RegExp('^' + esc(n.slice(0, i)) + '_חלק_\\d+__' + esc(n.slice(i + 2)) + '_Chelek_\\d+$').test(s)) return true;
  }
  return false;
}
const esc = s => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

export async function deleteFromAll(dir, file, io, log = console) {
  dir = String(dir || '').replace(/\/$/, '');
  if (dir !== '/7' || !/^\d{3}$/.test(String(file))) throw new Error('not an extension 7 file');
  const report = { file: dir + '/' + file, removed: [] };
  // 1. The list: which item this number is.
  const idx = (await io.readJson(INDEX).catch(() => null)) || { items: {} };
  const keys = Object.entries(idx.items || {}).filter(([, e]) => String(e?.file) === String(file)).map(([k]) => k);
  // 2. The file itself.
  await io.del('ivr2:/7/' + file + '.wav');
  report.removed.push('/7/' + file + '.wav');
  if (keys.length) {
    const fresh = (await io.readJson(INDEX).catch(() => null)) || idx;
    for (const k of keys) delete fresh.items?.[k];
    await io.writeJson(INDEX, fresh);
    report.keys = keys;
  }
  // 3. Every other copy, by what the file was.
  const owners = (await io.readJson(OWNERS).catch(() => null)) || {};
  const names = new Set(), aiTags = [];
  for (const k of keys) {
    for (const [name, owner] of Object.entries(owners)) if (owner === k) names.add(name);
    const ai = /^ai-song-(.+)$/.exec(k);
    if (ai) aiTags.push(' - ' + ai[1].slice(0, 6));
    else await io.delDir(cacheDirOf(k)).then(() => report.removed.push(cacheDirOf(k).slice(5))).catch(() => {});
  }
  const matches = n => belongs(n, [...names]) || aiTags.some(t => stem(n).endsWith(t));
  if (names.size || aiTags.length) {
    for (const base of [FOLDER_BASES.audio, FOLDER_BASES.video, ...(aiTags.length ? [FOLDER_BASES.ai] : [])]) {
      for (const f of await folders(base, io)) {
        for (const n of f.names) if (matches(n)) {
          await io.del(f.dir + '/' + n).then(() => report.removed.push(f.dir.slice(5) + '/' + n)).catch(e => log.warn?.('[EXT7 DELETE] a copy was not deleted', { what: f.dir + '/' + n, message: String(e?.message || e).slice(0, 100) }));
        }
      }
    }
    if (names.size) {
      const o2 = (await io.readJson(OWNERS).catch(() => null)) || owners;
      for (const n of names) delete o2[n];
      await io.writeJson(OWNERS, o2).catch(() => {});
    }
  }
  // 4. The AI extensions forget it now (their list is otherwise kept 5 min).
  await io.refreshAi?.().catch(() => {});
  log.info?.('[EXT7 DELETE] deleted from the whole system', report);
  // Where to go on: the next older file in 7, else the next newer one.
  const left = ((await io.list('ivr2:/7').catch(() => null)) || []).map(n => /^(\d{3})\.wav$/i.exec(n)?.[1]).filter(Boolean).map(Number).sort((a, b) => a - b);
  const n = Number(file);
  const older = left.filter(x => x < n).pop(), newer = left.find(x => x > n);
  const pad = x => String(x).padStart(3, '0');
  return { ...report, next: older !== undefined ? pad(older) : newer !== undefined ? pad(newer) : null, videoId: keys[0] || null };
}
