// Keys 8 and 9 while listening in extensions 7/8 (owner, 07.11).
// Yemot's playfile "send_api" sends: what (the playing file, e.g.
// ivr2:/7/005.wav), PlayStop (where the caller stopped), PressKey; and on the
// next request also our own value (dub_ok). Every answer ends by returning the
// caller to the SAME file at the SAME place (go_to_folder_and_play).
//   8 -> the file's details, spoken in Hebrew.
//   9 -> "translate to Hebrew dubbing? 1 = yes, 2 = cancel"; 1 starts the job.
const clean = t => String(t || '').replace(/https?:\/\/\S+/gi, ' ').replace(/[|=&.,"“”‘’'\\*_#<>\[\]{}\-–—]/g, ' ').replace(/[\u0000-\u001F\u007F]/g, ' ').replace(/\s+/g, ' ').trim();

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
    const lines = await deps.details(item.videoId, item.title, item.dub).catch(() => null);
    return say(...(lines?.length ? lines : ['אין לי פרטים נוספים על הקובץ הזה']), 'ממשיכים בהשמעה') + '&' + back;
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
