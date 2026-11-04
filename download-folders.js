// Where downloadable files go: top-level folders outside every extension
// (owner's choice 04.11): ivr2:/אודיו and ivr2:/וידאו. Yemot allows at most
// 3,000 files in one folder (their storage rules), so after 2,900 files the
// next file goes to "אודיו_2", then "אודיו_3", and so on, automatically.
export const AUDIO_BASE = 'ivr2:/אודיו';
export const VIDEO_BASE = 'ivr2:/וידאו';
const INDEX = 'ivr2:/2/youtubeaudio/download_folders.json';
export const FOLDER_LIMIT = 2900;

export function folderName(base, n) { return n <= 1 ? base : base + '_' + n; }

export async function nextFolder(kind, { readJson }) {
  const idx = (await readJson(INDEX).catch(() => null)) || {};
  const cur = idx[kind] || { n: 1, count: 0 };
  const n = cur.count >= FOLDER_LIMIT ? cur.n + 1 : cur.n;
  return folderName(kind === 'video' ? VIDEO_BASE : AUDIO_BASE, n);
}
// Counts one saved file (after it is verified in Yemot).
export async function countSaved(kind, { readJson, writeJson }) {
  const idx = (await readJson(INDEX).catch(() => null)) || {};
  const cur = idx[kind] || { n: 1, count: 0 };
  const next = cur.count >= FOLDER_LIMIT ? { n: cur.n + 1, count: 1 } : { n: cur.n, count: cur.count + 1 };
  await writeJson(INDEX, { ...idx, [kind]: next }).catch(() => {});
}
