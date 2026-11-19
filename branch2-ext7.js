// Extension 7: listen to the songs extension 2 downloaded, newest first.
//
// Yemot's playfile extension plays the highest-numbered file first and then
// goes down (documented default: with 000 and 001 it plays 001, then 000). So
// every newly prepared song is copied to /7 under the NEXT number and the
// order is automatically newest -> oldest, to the end.
//
// Keys (owner's layout 04.11; Yemot playfile control values, documented):
//   5 = wait                  -> pause; press 5 again to continue
//   1 = seconds_plus          -> 10 seconds forward
//   3 = seconds_minus         -> 10 seconds back
//   4 = minus                 -> the file uploaded before (older)
//   6 = plus                  -> the newer file
//   7 = minut_plus_amount1    -> 3 minutes forward (minut_plus_amount1=180000 ms)
//   0 = go_to_folder          -> back to the main menu (playfile_control_play_0_goto=/)
//   * = Yemot's own star menu (playlist settings), as before (owner, 12.11)
//   8 = send_api              -> the file's details, spoken (owner, 07.11)
//   9 = send_api              -> Hebrew dubbing of the file, after 1 = yes / 2 = no
export const PLAY_KEYS = {
  control_play1: 'seconds_plus',
  control_play3: 'seconds_minus',
  control_play4: 'minus',
  control_play5: 'wait',
  control_play6: 'plus',
  control_play7: 'minut_plus_amount1',
  minut_plus_amount1: '180000',
  control_play0: 'go_to_folder',
  playfile_control_play_0_goto: '/',
  // 8 = the file's details spoken; 9 = Hebrew dubbing (asks 1/2 first).
  // Yemot sends the playing file (what) and position (PlayStop) to api_link
  // (set at start to <server>/yemot-media); playback then resumes there.
  control_play8: 'send_api',
  control_play9: 'send_api',
  api_hangup_send: 'no',
};
export const EXT7_PATH = 'ivr2:/7';
export const EXT7_SETTINGS = {
  type: 'playfile',
  title: 'השירים החדשים',
  start: 'max',
  ...PLAY_KEYS,
  // Remember where the caller stopped, so extension 8 can return there.
  save_last_play: 'yes',
};

// Lines of an ext.ini that set a key this layout does not use (e.g. an older
// "control_play2=seconds_minus") are removed so no stale key stays active.
export function stripUnusedKeys(iniText, settings) {
  return String(iniText || '').split(/\r?\n/).filter(line => {
    const m = /^\s*(control_play[0-9*#])\s*=/.exec(line);
    if (m) return m[1] in settings;
    const g = /^\s*playfile_control_play_([0-9*#])_goto\s*=/.exec(line);
    return !g || ('control_play' + g[1]) in settings;
  }).join('\n');
}

// Extension 8: return to the exact place the caller last stopped listening
// (Yemot's built-in "last_play" module; positions are saved by extension 7).
export const EXT8_PATH = 'ivr2:/8';
export const EXT8_SETTINGS = {
  type: 'last_play',
  ...PLAY_KEYS,
  title: 'חזרה למקום האחרון',
};

// Which video got which number; kept beside the extension 2 audio, not in /7,
// so the playfile extension holds audio only.
const INDEX = 'ivr2:/2/youtubeaudio/ext7_index.json';
let chain = Promise.resolve();

export function ext7FileName(n) {
  return String(n).padStart(3, '0');
}

// Adds one prepared song to extension 7 exactly once (by video id). Calls are
// serialized so two songs finishing together never get the same number.
export function publishToExt7(videoId, localWav, title, io) {
  const job = chain.then(async () => {
    const index = (await io.readJson(INDEX).catch(() => null)) || { version: 1, next: 0, items: {} };
    if (index.items?.[videoId]) {
      io.log?.info?.('[EXT7] already listed', { videoId, file: index.items[videoId].file });
      return index.items[videoId];
    }
    const n = Number.isInteger(index.next) && index.next >= 0 ? index.next : 0;
    if (n > 999) throw Object.assign(new Error('Extension 7 is full (1000 files)'), { code: 'ext7_full' });
    const file = ext7FileName(n);
    const entry = { file, title: String(title || '').slice(0, 120), at: new Date().toISOString() };
    // Reserve the number BEFORE uploading: a failure can leave a harmless gap,
    // never two songs on one number.
    const items = { ...(index.items || {}) };
    await io.writeJson(INDEX, { version: 1, next: n + 1, items });
    await io.upload(localWav, EXT7_PATH + '/' + file + '.wav');
    await io.writeJson(INDEX, { version: 1, next: n + 1, items: { ...items, [videoId]: entry } });
    io.log?.info?.('[EXT7] song added', { videoId, file });
    return entry;
  });
  chain = job.catch(() => {});
  return job;
}

// One-time fill: every song already saved by extension 2 (including older
// ones stored in 2-minute pieces, which are joined into ONE file) is added in
// the order it was saved, so the newest still gets the highest number.
// io: listSongDirs() -> [dirName], readJson(path), downloadTo(remote, localFile),
//     joinWavs([local...], outFile), upload(local, remote), tempDir(), log
export async function backfillExt7(io, { mark = 'ivr2:/2/youtubeaudio/ext7_backfill_v1.json', sinceMs = 0 } = {}) {
  const MARK = mark;
  if (await io.readJson(MARK).catch(() => null)) return { skipped: true };
  const songs = [];
  const dirs = await io.listSongDirs();
  // Nothing listed most likely means the listing failed: retry next start
  // instead of marking the fill as done.
  if (!dirs.length) { io.log?.warn?.('[EXT7] backfill found no saved song folders; will retry on next start'); return { added: [] }; }
  for (const dir of dirs) {
    if (!/^[0-9a-f]{22}$/.test(dir)) continue; // hex of an 11-char video id
    const manifest = await io.readJson('ivr2:/2/youtubeaudio/' + dir + '/complete.json').catch(() => null);
    if (manifest?.complete !== true || !Array.isArray(manifest.playbackPaths) || !manifest.playbackPaths.length) continue;
    const at = Date.parse(manifest.createdAt) || 0;
    if (sinceMs && at < sinceMs) continue;
    songs.push({ videoId: manifest.videoId, paths: manifest.playbackPaths, at });
  }
  songs.sort((a, b) => a.at - b.at);
  const added = [];
  for (const song of songs) {
    const dir = await io.tempDir();
    try {
      const parts = [];
      for (let i = 0; i < song.paths.length; i++) {
        const local = dir + '/part' + String(i).padStart(4, '0') + '.wav';
        await io.downloadTo('ivr2:' + song.paths[i] + '.wav', local);
        parts.push(local);
      }
      let file = parts[0];
      if (parts.length > 1) { file = dir + '/joined.wav'; await io.joinWavs(parts, file); }
      const title = decodeURIComponent(String(song.paths[0].split('/').pop()).replace(/_/g, ' '));
      await publishToExt7(song.videoId, file, /^(?:q\d_)?\d{3}$|^q\dfull$/.test(song.paths[0].split('/').pop()) ? '' : title, io);
      added.push(song.videoId);
    } catch (e) {
      io.log?.warn?.('[EXT7] backfill skipped a song', { videoId: song.videoId, message: String(e?.message || e).slice(0, 200) });
    } finally { await io.removeDir?.(dir); }
  }
  await io.writeJson(MARK, { at: new Date().toISOString(), added });
  io.log?.info?.('[EXT7] backfill done', { songs: songs.length, added: added.length });
  return { added };
}
