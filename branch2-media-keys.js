// Keys 8 and 9 while listening in extensions 7/8 (owner, 07.11).
// Yemot's playfile "send_api" sends: what (the playing file, e.g.
// ivr2:/7/005.wav), PlayStop (where the caller stopped), PressKey; and on the
// next request also our own value (dub_ok). Every answer ends by returning the
// caller to the SAME file at the SAME place (go_to_folder_and_play).
//   8 -> the file's details, spoken in Hebrew.
//   9 -> "translate to Hebrew dubbing? 1 = yes, 2 = cancel"; 1 starts the job.
// Emoji and symbols are removed (the speech engine reads them as noise or names).
const clean = t => String(t || '').replace(/[\p{Extended_Pictographic}\u{1F1E6}-\u{1F1FF}\u200d\ufe0f\u25c4\u25ba\u2022]/gu, ' ').replace(/https?:\/\/\S+/gi, ' ').replace(/[|=&.,"“”‘’'\\*_#<>\[\]{}\-–—]/g, ' ').replace(/[\u0000-\u001F\u007F]/g, ' ').replace(/\s+/g, ' ').trim();

export function parseWhat(what) {
  const m = /^ivr2:\/?(.*?)\/?([^/]+?)(?:\.[A-Za-z0-9]{2,4})?$/.exec(String(what || ''));
  if (!m) return null;
  return { dir: '/' + m[1].replace(/^\/+|\/+$/g, ''), file: m[2] };
}

export function backTo(what, playStop) {
  const p = parseWhat(what);
  if (!p) return 'go_to_folder=/7';
  const pos = Number(playStop) > 0 ? Math.floor(Number(playStop)) : 0;
  return 'go_to_folder_and_play=' + p.dir + ',' + p.file + ',' + pos;
}

// Owner, 25.11: the details are read as a question that takes ANY key, so a
// press in the middle stops them and playback goes on; with no press, playback
// goes on one second after the last word. (read: 1 digit, 1 s wait, every key
// incl. * and #, one try, empty allowed.)
export const skippable = lines => 'read=' + [...lines, 'ממשיכים בהשמעה'].filter(Boolean).map(t => 't-' + clean(t)).join('.') + '=skip8,no,1,1,1,No,no,no,,,1,Ok,None,';
const say = (...parts) => 'id_list_message=' + parts.filter(Boolean).map(t => 't-' + clean(t)).join('.');

// deps: lookup(dir, file) -> { videoId, title, dub } | null;
//       details(videoId, title) -> [sentences]; dubStatus(videoId) -> {state, file}
//       startDub(videoId, title); language(title) -> { name, code } | null
export async function handleMediaKey(q, deps, log = console) {
  if (q.hangup === 'yes') return 'noop';
  const what = String(q.what || '');
  const back = backTo(what, q.PlayStop);
  const key = String(q.PressKey || '').split('-').pop();
  const p = parseWhat(what);
  const item = p ? await deps.lookup(p.dir, p.file).catch(() => null) : null;

  // The details were heard (or cut short by any key): back to the same place.
  if (q.skip8 !== undefined) return back;

  // Key 2 in extension 11 (owner, 25.11): delete this file, after 1 = yes.
  if (q.del_ok !== undefined && q.del_ok !== '') {
    if (String(q.del_ok) !== '1' || !p || !deps.canDelete?.(p.dir)) return say('בוטל. ממשיכים בהשמעה') + '&' + back;
    try {
      const r = await deps.deleteFile(p.dir, p.file);
      log.info?.('[NEWS11] file deleted by caller', { dir: p.dir, file: p.file, videoId: r?.videoId || null });
      return say('הקובץ נמחק') + '&' + (r?.next ? 'go_to_folder_and_play=' + p.dir + ',' + r.next + ',0' : 'go_to_folder=' + p.dir.replace(/\/[^/]+$/, '') );
    } catch (e) {
      log.warn?.('[NEWS11] delete failed', { what, message: String(e?.message || e).slice(0, 120) });
      return say('המחיקה לא הצליחה כרגע. ממשיכים בהשמעה') + '&' + back;
    }
  }
  if (key === '2' && p && deps.canDelete?.(p.dir)) {
    const question = ['האם למחוק את הקובץ', 'למחיקה הקש 1', 'לביטול הקש 2'].map(t => 't-' + clean(t)).join('.');
    return 'read=' + question + '=del_ok,no,1,1,10,No,yes,no,,1.2,1,Ok,2,';
  }

  // The answer to the dubbing question.
  if (q.dub_ok !== undefined && q.dub_ok !== '') {
    if (String(q.dub_ok) !== '1') return say('בוטל. ממשיכים בהשמעה') + '&' + back;
    if (!item?.videoId) return say('לא מצאתי מאיזה סרטון הקובץ הזה, ולכן אי אפשר לדבב אותו') + '&' + back;
    const st = deps.startDub(item.videoId, item.title);
    log.info?.('[DUB] requested by caller', { videoId: item.videoId, file: p?.file, status: st?.status });
    return say('הדיבוב לעברית התחיל', 'כשהוא יסתיים הקובץ המדובב יופיע ראשון ברשימת הקבצים בשלוחה 7', 'בדרך כלל זה לוקח כמה דקות', 'ממשיכים בהשמעה') + '&' + back;
  }

  if (key === '8') {
    if (!item?.videoId) return say('אין לי פרטים על הקובץ הזה') + '&' + back;
    const lines = await deps.details(item.videoId, item.title, item.dub, { channel: item.channel || '' }).catch(() => null);
    return skippable(lines?.length ? lines : ['אין לי פרטים נוספים על הקובץ הזה']);
  }

  if (key === '9') {
    if (!item?.videoId) return say('לא מצאתי מאיזה סרטון הקובץ הזה, ולכן אי אפשר לדבב אותו') + '&' + back;
    if (item.dub) return say('הקובץ הזה כבר מדובב לעברית') + '&' + back;
    const st = await deps.dubStatus(item.videoId).catch(() => null);
    if (st?.state === 'running') return say('הדיבוב לעברית של הקובץ הזה כבר בתהליך') + '&' + back;
    if (st?.state === 'done' && st.file) return say('לקובץ הזה כבר יש דיבוב לעברית, בקובץ מספר ' + Number(st.file) + ' ברשימה') + '&' + back;
    const lang = deps.language ? await deps.language(item.videoId, item.title).catch(() => null) : null;
    const intro = lang?.code === 'he' ? 'נראה שהקובץ הזה כבר בעברית' : lang?.name ? 'הקובץ הזה ב' + lang.name : '';
    const question = [intro, 'האם לתרגם את הקובץ לדיבוב בעברית', 'לאישור הקש 1', 'לביטול הקש 2'].filter(Boolean).map(t => 't-' + clean(t)).join('.');
    // read: one key, 1 or 2 only, 10 seconds; no answer counts as cancel.
    return 'read=' + question + '=dub_ok,no,1,1,10,No,yes,no,,1.2,1,Ok,2,';
  }
  return back;
}
