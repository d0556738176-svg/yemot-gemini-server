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
function startVideoSay(v, deps, log) {
  const st = deps.startVideo(v);
  log.info?.('[VIDEO88] requested from a playing file', { videoId: v.videoId, subtitles: v.subtitles, status: st?.status || null });
  if (st?.status === 'ready') return say('הסרטון הזה כבר שמור בתיקיית וידאו', 'ממשיכים בהשמעה');
  return say('הורדת הסרטון התחילה' + (v.subtitles ? ', עם כתובית בעברית' : ', בלי כתובית'), 'הוא יישמר בתיקיית וידאו באיכות הטובה ביותר, גם אם הוא ארוך', 'אין צורך להמתין', 'ממשיכים בהשמעה');
}

export async function handleMediaKey(q, deps, log = console) {
  if (q.hangup === 'yes') return 'noop';
  const what = String(q.what || '');
  const back = backTo(what, q.PlayStop);
  const key = String(q.PressKey || '').split('-').pop();
  const p = parseWhat(what);
  const item = p ? await deps.lookup(p.dir, p.file).catch(() => null) : null;

  // Owner, 27.11 (extension 11, every folder in it): 8 and 8 again = save the
  // video from YouTube to the video folder, asking first with or without
  // Hebrew subtitles. The second 8 is the key that cuts the details short.
  const videoOk = p && item?.videoId && deps.canVideo?.(p.dir) && deps.startVideo;
  // The subtitles answer: 1 = with, 2 = without. The free download first;
  // a second download (redo) or the paid engine only after another 1.
  if (q.vid_sub !== undefined && q.vid_sub !== '' && q.vid_ok === undefined) {
    if (!['1', '2'].includes(String(q.vid_sub)) || !videoOk) return say('בוטל. ממשיכים בהשמעה') + '&' + back;
    const v = { videoId: item.videoId, title: item.title, channelTitle: item.channel || '', subtitles: String(q.vid_sub) === '1' };
    const gate = deps.videoGate ? await deps.videoGate(v).catch(() => null) : null;
    if (gate) return 'read=' + 't-' + clean(gate.prompt) + '=vid_ok,no,1,1,10,No,no,no,,1.2,1,Ok,2,';
    return startVideoSay(v, deps, log) + '&' + back;
  }
  if (q.vid_ok !== undefined && q.vid_ok !== '') {
    if (String(q.vid_ok) !== '1' || !videoOk || !['1', '2'].includes(String(q.vid_sub))) return say('בוטל. ממשיכים בהשמעה') + '&' + back;
    const v = { videoId: item.videoId, title: item.title, channelTitle: item.channel || '', subtitles: String(q.vid_sub) === '1', paidConsent: true, redoConsent: true };
    return startVideoSay(v, deps, log) + '&' + back;
  }
  if (q.skip8 !== undefined) {
    if (String(q.skip8) === '8' && p && deps.canVideo?.(p.dir)) {
      if (!item?.videoId) return say('הקובץ הזה לא מיוטיוב, ולכן אי אפשר להוריד אותו כסרטון') + '&' + back;
      const question = ['להורדת הקובץ כסרטון לתיקיית וידאו', 'עם כתובית בעברית הקש 1', 'בלי כתובית הקש 2'].map(t => 't-' + clean(t)).join('.');
      // one key, 1 or 2, 10 seconds; no answer = cancel (0).
      return 'read=' + question + '=vid_sub,no,1,1,10,No,yes,no,,1.2,1,Ok,0,';
    }
    return back;
  }

  // Key 2 in extension 11 (owner, 25.11): delete this file, after 1 = yes.
  if (q.del_ok !== undefined && q.del_ok !== '') {
    if (String(q.del_ok) !== '1' || !p || !deps.canDelete?.(p.dir)) return say('בוטל. ממשיכים בהשמעה') + '&' + back;
    try {
      const r = await deps.deleteFile(p.dir, p.file);
      log.info?.('[NEWS11] file deleted by caller', { dir: p.dir, file: p.file, videoId: r?.videoId || null });
      return say(r?.spoken || 'הקובץ נמחק') + '&' + (r?.next ? 'go_to_folder_and_play=' + p.dir + ',' + r.next + ',0' : 'go_to_folder=' + p.dir.replace(/\/[^/]+$/, '') );
    } catch (e) {
      log.warn?.('[NEWS11] delete failed', { what, message: String(e?.message || e).slice(0, 120) });
      return say('המחיקה לא הצליחה כרגע. ממשיכים בהשמעה') + '&' + back;
    }
  }
  if (key === '2' && p && deps.canDelete?.(p.dir)) {
    const question = [...(deps.deleteQuestion?.(p.dir) || ['האם למחוק את הקובץ']), 'למחיקה הקש 1', 'לביטול הקש 2'].map(t => 't-' + clean(t)).join('.');
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
    // 25.11: a file from a channel site (not YouTube) has its title and channel.
    // 28.11: a file saved before its details were kept says so (and how to remove it).
    if (!item?.videoId) return say(...(item?.title ? ['זה ' + item.title + (item.channel ? ', מהערוץ ' + item.channel : '')] : p && deps.canDelete?.(p.dir) ? ['הקובץ הזה נשמר לפני שהמערכת התחילה לשמור את הפרטים של הקבצים, ולכן אין לי פרטים עליו', 'למחיקת הקובץ הקש 2'] : ['אין לי פרטים על הקובץ הזה'])) + '&' + back;
    const lines = await deps.details(item.videoId, item.title, item.dub, { channel: item.channel || '' }).catch(() => null);
    const more = deps.canVideo?.(p.dir) ? ['להורדת הקובץ כסרטון לתיקיית וידאו הקש 8'] : [];
    return skippable([...(lines?.length ? lines : ['אין לי פרטים נוספים על הקובץ הזה']), ...more]);
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
