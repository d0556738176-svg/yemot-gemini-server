// Where downloadable files go: top-level folders outside every extension
// (owner's choice 04.11): ivr2:/אודיו and ivr2:/וידאו. Yemot allows at most
// 3,000 files in one folder (their storage rules), so after 2,900 files the
// next file goes to "אודיו_2", then "אודיו_3", and so on, automatically.
export const AUDIO_BASE = 'ivr2:/אודיו';
export const VIDEO_BASE = 'ivr2:/וידאו';
const INDEX = 'ivr2:/2/youtubeaudio/download_folders.json';
export const FOLDER_LIMIT = 2900;

export function folderName(base, n) { return n <= 1 ? base : base + '_' + n; }

// The real number of files in Yemot decides (15.11: the saved counter had
// drifted from the folder by a few files). countFiles(path) -> number|null;
// when Yemot cannot be asked, the saved counter is used as before.
export async function nextFolder(kind, { readJson, writeJson, countFiles } = {}) {
  const idx = (await readJson(INDEX).catch(() => null)) || {};
  let cur = idx[kind] || { n: 1, count: 0 };
  const base = kind === 'video' ? VIDEO_BASE : AUDIO_BASE;
  if (countFiles) {
    for (let guard = 0; guard < 50; guard++) {
      const real = await countFiles(folderName(base, cur.n)).catch(() => null);
      if (!Number.isFinite(real)) break;
      if (real < FOLDER_LIMIT) { if (real !== cur.count) { cur = { n: cur.n, count: real }; await writeJson?.(INDEX, { ...idx, [kind]: cur }).catch(() => {}); } break; }
      cur = { n: cur.n + 1, count: 0 };
      await writeJson?.(INDEX, { ...idx, [kind]: cur }).catch(() => {});
    }
    return folderName(base, cur.n);
  }
  const n = cur.count >= FOLDER_LIMIT ? cur.n + 1 : cur.n;
  return folderName(base, n);
}
// Counts one saved file (after it is verified in Yemot).
export async function countSaved(kind, { readJson, writeJson }) {
  const idx = (await readJson(INDEX).catch(() => null)) || {};
  const cur = idx[kind] || { n: 1, count: 0 };
  const next = cur.count >= FOLDER_LIMIT ? { n: cur.n + 1, count: 1 } : { n: cur.n, count: cur.count + 1 };
  await writeJson(INDEX, { ...idx, [kind]: next }).catch(() => {});
}
// Files in one Yemot folder (a folder that does not exist yet has 0).
export async function yemotFileCount(path, { apiBase, token, fetchImpl = fetch }) {
  const u = new URL(apiBase + '/GetIVR2Dir'); u.searchParams.set('token', token); u.searchParams.set('path', path);
  const j = await (await fetchImpl(u, { signal: AbortSignal.timeout(15000) })).json();
  if (j?.responseStatus === 'OK') return (j.files || []).length + (j.ini || []).length;
  if (/not ?found|exist|לא קיים/i.test(String(j?.message || ''))) return 0;
  return null;
}
