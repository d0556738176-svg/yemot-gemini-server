// Extension 4: AI song maker (owner, 12-13.11).
//
// The caller says what song he wants; the AI writes Hebrew lyrics; the free
// engine (official ACE-Step model on a GitHub runner) composes it. That takes
// minutes, so while waiting the caller hears an update about every half
// minute and may press 0 to leave for the main menu: the song keeps being
// made and is saved anyway in extension 7 ("the new songs"). If he stays,
// the song plays here as soon as it is ready.
import { ExitError, HangupError, TimeoutError } from 'yemot-router2';
import { createSong, warmMusicEngine, cloudJobStatus, noteSongEvent } from './song-generator.js';

const WAIT_SECONDS = Math.max(10, Math.min(60, Number(process.env.SONG_WAIT_PROMPT_SECONDS || 25)));
const HANGUP_RE = /hang.?up|disconnected|socket hang up|connection closed/i;
const isHangup = e => e instanceof HangupError || HANGUP_RE.test(String(e?.message || e));

export function waitMessage({ title, elapsedSec, stage, first }) {
  const minutes = Math.floor(elapsedSec / 60);
  if (first) {
    return 'כתבתי את המילים לשיר ' + (title ? '"' + title + '"' : '') + ', ועכשיו מלחינים ומקליטים אותו. ' +
      'זה לוקח בדרך כלל בין עשר לעשרים דקות. אפשר להמתין על הקו, ואשמיע את השיר מיד כשהוא מוכן. ' +
      'אם תרצו לצאת, הקישו אפס. השיר ימשיך להיווצר ויישמר בשלוחה שבע.';
  }
  const stageText = stage === 'starting' ? 'מכינים את האולפן' : stage === 'generating' ? 'המנוע מלחין ושר את השיר' : 'השיר בהכנה';
  return stageText + (minutes >= 1 ? ', עברו ' + (minutes === 1 ? 'דקה אחת' : minutes + ' דקות') : '') +
    '. ממשיכים לחכות. ליציאה לתפריט הראשי הקישו אפס.';
}

// Owner, 23.11: extension 4 as a menu. 1 = by topic, 2 = by your own lyrics,
// 3 = a new version of a YouTube song; then voice, style and length, each
// said back with 1 = confirm / 2 = again. The engine itself is unchanged: the
// choices become the request it already understands.
export const SONG_KINDS = { '1': 'לפי נושא', '2': 'לפי מילים שלך', '3': 'גרסה חדשה לשיר מיוטיוב' };
export const SONG_VOICES = [
  { key: '1', name: 'זמר גבר', ask: 'בקול של זמר גבר' },
  { key: '2', name: 'ילד', ask: 'בקול של ילד' },
  { key: '3', name: 'מקהלת גברים', ask: 'בשירה של מקהלה' },
  { key: '4', name: 'מקהלת ילדים', ask: 'בשירה של מקהלת ילדים' },
  { key: '5', name: 'בלי שירה, רק נגינה', ask: 'בלי שירה, נגינה בלבד' }
];
export const SONG_STYLES = [
  { key: '1', name: 'רגוע', ask: 'בסגנון רגוע ושליו, קצב איטי, פסנתר וגיטרה אקוסטית' },
  { key: '2', name: 'שמח וקצבי', ask: 'בסגנון שמח וקצבי, מתאים לריקוד' },
  { key: '3', name: 'סוער ועוצמתי', ask: 'בסגנון סוער ועוצמתי, תופים חזקים וגיטרות חשמליות' },
  { key: '4', name: 'ראפ', ask: 'בסגנון ראפ, ביט היפ הופ, שירה מדוברת וקצבית' },
  { key: '5', name: 'חסידי', ask: 'בסגנון חסידי שמח, כלי נשיפה וכינור' },
  { key: '6', name: 'מזרחי', ask: 'בסגנון מזרחי, עוד, כלי מיתר וסלסולים' },
  { key: '7', name: 'בלדה מרגשת', ask: 'בסגנון בלדה מרגשת, כלי מיתר ופסנתר' },
  { key: '8', name: 'פופ', ask: 'בסגנון פופ קליט ומודרני' }
];
export const SONG_MINUTES = ['1', '2', '3', '4'];
const minutesText = m => ({ '1': 'דקה אחת', '2': 'שתי דקות', '3': 'שלוש דקות', '4': 'ארבע דקות' })[m] || 'דקה אחת';

/** The request the engine already understands, built from the menu choices. */
export function buildSongPrompt({ kind, text = '', ytTitle = '', voice, style, minutes }) {
  const v = SONG_VOICES.find(x => x.key === voice) || SONG_VOICES[0];
  const st = SONG_STYLES.find(x => x.key === style) || SONG_STYLES[0];
  const secs = Math.max(30, Math.min(240, Number(minutes || 1) * 60));
  const what = kind === '2'
    ? 'שיר עם המילים שהמתקשר הכתיב, בדיוק כפי שנאמרו: ' + text
    : kind === '3'
      ? 'קאבר: גרסה חדשה בהשראת השיר "' + ytTitle + '" מיוטיוב, עם מילים חדשות ומקוריות' + (text ? ' בנושא: ' + text : ' באותו נושא כללי ובאותה אווירה')
      : 'שיר על הנושא: ' + text;
  return [what, v.ask, st.ask, 'אורך השיר: ' + minutesText(String(minutes)) + ' (' + secs + ' שניות), duration_seconds=' + secs + '.',
    'כל הפרטים כבר נבחרו בתפריט, כולל האורך: אל תשאל שאלות הבהרה (needs_clarification=false) וצור את השיר.'].join('. ');
}

export function createSongCallHandler({
  yemotApi,
  transcribePhoneAudio,
  generateText,
  sanitizeForYemot,
  withTimeout,
  getCallerNumber,
  logDetailedError,
  searchYouTube = null
}) {
  return async function songCallHandler(call) {
    const callId = String(call?.callId || call?.values?.ApiCallId || ('song-' + Date.now()));
    const caller = getCallerNumber(call);
    const say = value => sanitizeForYemot(value);
    let prompt = 'ברוכים הבאים ליוצר השירים. אמרו על מה השיר, באיזה סגנון ובאיזה קול: גבר, ילד או ילדה. אפשר גם להכתיב את מילות השיר בעצמכם. למשל: שיר שמח לכבוד שבת עם גיטרה בקול של ילד. בסיום הדיבור הקישו סולמית.';
    let transcript = '';
    let pendingRequest = '';
    let awaitingClarification = false;
    let clarificationCount = 0;
    warmMusicEngine();

    // ---- the menu (owner, 23.11) ----
    const tap = async (text, allowed, wait = 10) => String(await call.read([{ type: 'text', data: say(text) }], 'tap', {
      max_digits: 1, min_digits: 1, sec_wait: wait, allow_empty: true, empty_val: 'None', typing_playback_mode: 'No',
      digits_allowed: [...allowed, '*'], timeout: 10 * 60 * 1000 }) || 'None').trim();
    const record = async text => {
      const path = await call.read([{ type: 'text', data: say(text) }], 'record', { min_length: 1, max_length: 90, no_confirm_menu: true, timeout: 10 * 60 * 1000 });
      if (!path || path === 'None') return '';
      const r = await withTimeout(yemotApi.download_file('ivr2:' + path), Number(process.env.REQUEST_TIMEOUT_MS || 30000), 'song menu recording download');
      return String(await transcribePhoneAudio(r.data) || '').trim();
    };
    // Choose from a list, say it back, 1 = confirm, 2 = choose again.
    const choose = async (question, list) => {
      for (let round = 0; round < 6; round++) {
        const k = await tap(question + ' ' + list.map(x => x.name + ' הקש ' + x.key).join(', ') + '.', list.map(x => x.key));
        if (k === '*') return '*';
        const pick = list.find(x => x.key === k);
        if (!pick) continue;
        const c = await tap('בחרת: ' + pick.name + '. לאישור הקש 1, לבחירה מחדש הקש 2.', ['1', '2']);
        if (c === '*') return '*';
        if (c === '1') return pick.key;
      }
      return list[0].key;
    };
    // Record, say back what was understood, 1 = confirm, 2 = record again.
    const recordConfirmed = async (ask, sayBack) => {
      for (let round = 0; round < 5; round++) {
        const t = await record(ask + ' בסיום הדיבור הקש סולמית.');
        if (t.length < 2) { ask = 'לא שמעתי. ' + ask; continue; }
        const c = await tap(sayBack(t) + ' לאישור הקש 1, לביטול והקלטה מחדש הקש 2.', ['1', '2']);
        if (c === '*') return '*';
        if (c === '1') return t;
      }
      return '';
    };
    async function songMenu() {
      let step = 'kind', kind = '', text = '', ytTitle = '', voice = '', style = '', minutes = '';
      for (let guard = 0; guard < 40; guard++) {
        if (step === 'kind') {
          const k = await tap('ברוכים הבאים ליוצר השירים. ליצירת שיר לפי נושא הקש 1. לשיר לפי מילים שלך הקש 2. לגרסה חדשה לשיר מיוטיוב הקש 3.', ['1', '2', '3'], 12);
          if (k === '*') return null;
          if (!SONG_KINDS[k]) continue;
          kind = k; step = 'content'; continue;
        }
        if (step === 'content') {
          if (kind === '1') {
            const t = await recordConfirmed('אמור על מה יהיה השיר.', t => 'הנושא שבחרת: ' + t + '.');
            if (t === '*' || !t) { step = 'kind'; continue; }
            text = t;
          } else if (kind === '2') {
            const t = await recordConfirmed('אמור את מילות השיר, לאט וברור.', t => 'המילים שהבנתי: ' + t + '.');
            if (t === '*' || !t) { step = 'kind'; continue; }
            text = t;
          } else {
            let found = '';
            for (let r = 0; r < 4 && !found; r++) {
              const q = await record('אמור את שם השיר ואת שם הזמר. בסיום הקש סולמית.');
              if (q.length < 2) continue;
              let title = q;
              if (searchYouTube) {
                const res = await searchYouTube(q).catch(() => []);
                if (res?.[0]?.title) title = res[0].title;
              }
              const c = await tap('מצאתי: ' + title + '. לאישור הקש 1, לחיפוש מחדש הקש 2.', ['1', '2']);
              if (c === '*') break;
              if (c === '1') found = title;
            }
            if (!found) { step = 'kind'; continue; }
            ytTitle = found;
            const t = await tap('על מה יהיו המילים החדשות? להקלטת נושא הקש 1. להשאיר את אותו נושא כללי הקש 2.', ['1', '2']);
            if (t === '1') { const tt = await recordConfirmed('אמור את הנושא למילים החדשות.', x => 'הנושא שבחרת: ' + x + '.'); if (tt && tt !== '*') text = tt; }
          }
          step = 'voice'; continue;
        }
        if (step === 'voice') { const v = await choose('באיזה קול?', SONG_VOICES); if (v === '*') { step = 'content'; continue; } voice = v; step = 'style'; continue; }
        if (step === 'style') { const v = await choose('באיזה סגנון?', SONG_STYLES); if (v === '*') { step = 'voice'; continue; } style = v; step = 'length'; continue; }
        if (step === 'length') {
          const m = await choose('באיזה אורך?', SONG_MINUTES.map(x => ({ key: x, name: minutesText(x) })));
          if (m === '*') { step = 'style'; continue; }
          minutes = m; step = 'sum'; continue;
        }
        if (step === 'sum') {
          const v = SONG_VOICES.find(x => x.key === voice), st = SONG_STYLES.find(x => x.key === style);
          const what = kind === '3' ? 'גרסה חדשה לשיר ' + ytTitle + (text ? ', בנושא ' + text : '') : kind === '2' ? 'שיר עם המילים שלך' : 'שיר על ' + text;
          const c = await tap('לסיכום: ' + what + ', ' + v.name + ', בסגנון ' + st.name + ', באורך ' + minutesText(minutes) + '. ליצירת השיר הקש 1. להתחלה מחדש הקש 2.', ['1', '2'], 12);
          if (c === '1') return buildSongPrompt({ kind, text, ytTitle, voice, style, minutes });
          if (c === '*') { step = 'length'; continue; }
          if (c === '2') { step = 'kind'; continue; }
        }
      }
      return null;
    }

    try {
      const menuPrompt = await songMenu();
      if (!menuPrompt) return call.go_to_folder('/');
      let fromMenu = menuPrompt;
      while (true) {
        let recordPath = null;
        if (!fromMenu) recordPath = await call.read(
          [{ type: 'text', data: say(prompt) }],
          'record',
          { min_length: 1, max_length: 60, no_confirm_menu: true, timeout: 10 * 60 * 1000 }
        );
        if (fromMenu) { transcript = fromMenu; fromMenu = ''; }
        else {
          if (!recordPath || recordPath === 'None') {
            return call.id_list_message([{ type: 'text', data: 'לא נקלטה בקשה. אפשר להתקשר שוב ולנסות ליצור שיר.' }]);
          }
          const response = await withTimeout(
            yemotApi.download_file('ivr2:' + recordPath),
            Number(process.env.REQUEST_TIMEOUT_MS || 30000),
            'song request recording download'
          );
          transcript = String(await transcribePhoneAudio(response.data) || '').trim();
        }
        if (awaitingClarification && pendingRequest) {
          transcript = pendingRequest + '\nהעדפה נוספת של המתקשר: ' + transcript;
          pendingRequest = '';
          awaitingClarification = false;
        }
        console.info('[SONG] VOICE_INPUT', { callId, chars: transcript.length });
        if (transcript.length < 3) {
          prompt = 'לא הצלחתי להבין את הבקשה. אמרו בקצרה איזה שיר תרצו, ובסיום הקישו סולמית.';
          continue;
        }

        let jobDone = false, jobResult = null, jobError = null;
        const info = { title: '', songId: '', startedAt: 0 };
        const jobPromise = createSong({
          prompt: transcript,
          callId,
          userKey: caller === 'לא מזוהה' ? callId : caller,
          generateText,
          onStatus: state => {
            if (state.status === 'generating_music') Object.assign(info, { title: state.title || '', songId: state.songId || '', startedAt: Date.now() });
            console.info('[SONG] JOB_STATUS', { callId, status: state.status });
          }
        }).then(r => { jobDone = true; jobResult = r; }, e => { jobDone = true; jobError = e; });

        let announced = false;
        while (!jobDone) {
          let text;
          if (info.startedAt && !announced) { text = waitMessage({ title: info.title, elapsedSec: 0, first: true }); announced = true; }
          else if (info.startedAt) {
            const st = info.songId ? cloudJobStatus(info.songId) : {};
            text = waitMessage({ elapsedSec: (Date.now() - info.startedAt) / 1000, stage: st.stage });
          } else text = 'רגע, אני כותב את המילים לשיר.';
          let key;
          try {
            key = await call.read([{ type: 'text', data: say(text) }], 'tap', {
              max_digits: 1, min_digits: 1, sec_wait: WAIT_SECONDS, allow_empty: true, empty_val: 'none', typing_playback_mode: 'No'
            });
          } catch (waitError) {
            if (waitError instanceof ExitError) throw waitError;
            if (isHangup(waitError)) {
              console.info('[SONG] CALLER_LEFT_WHILE_WAITING', { callId, songId: info.songId });
              return; // the song continues and is saved in extensions 4 and 7
            }
            if (waitError instanceof TimeoutError || /timeout|timed out|no input/i.test(String(waitError?.message || waitError))) continue;
            logDetailedError('Song status prompt', waitError);
            throw waitError;
          }
          if (String(key) === '0') {
            console.info('[SONG] CALLER_LEFT_TO_MENU', { callId, songId: info.songId });
            return call.go_to_folder('/');
          }
        }
        await jobPromise;

        if (jobError) {
          if (jobError.code === 'NEEDS_CLARIFICATION' && clarificationCount < 1) {
            clarificationCount++;
            prompt = 'אמרו בבקשה עוד קצת פרטים על השיר שתרצו, ובסיום הקישו סולמית.';
            continue;
          }
          const message = jobError.code === 'RATE_LIMITED'
            ? 'כבר יצרתם את מספר השירים המרבי לשעה. אפשר לנסות שוב מאוחר יותר.'
            : jobError.code === 'QUEUE_FULL'
              ? 'כרגע נוצרים שירים רבים. נסו שוב בעוד כמה דקות.'
              : 'מצטער, הייתה תקלה ביצירת השיר. אפשר לנסות שוב מאוחר יותר.';
          logDetailedError('Song generation', jobError);
          noteSongEvent('ivr_job_error', { code: jobError.code || '', status: jobError.status || '', message: String(jobError.message || jobError).slice(0, 200) });
          return call.id_list_message([{ type: 'text', data: say(message) }]);
        }

        if (jobResult?.needsClarification && menuPrompt && clarificationCount < 2) {
          // Owner, 24.11: everything was chosen in the menu, so the caller is
          // never asked again (it used to ask "60 or 180 seconds?"); the
          // writer is told once more to just write the song.
          clarificationCount++;
          noteSongEvent('menu_clarification_skipped', { question: String(jobResult.clarificationQuestion || '').slice(0, 120) });
          fromMenu = menuPrompt + ' חובה ליצור את השיר עכשיו לפי הפרטים האלה, בלי שום שאלה.';
          continue;
        }
        if (jobResult?.needsClarification) {
          if (clarificationCount >= 1) {
            return call.id_list_message([{ type: 'text', data: 'לא הצלחתי להבין את הסגנון המבוקש. אפשר להתחיל שוב עם תיאור קצר יותר.' }]);
          }
          clarificationCount++;
          pendingRequest = transcript;
          awaitingClarification = true;
          prompt = say(jobResult.clarificationQuestion || 'איזה סגנון מוזיקלי תרצו?');
          continue;
        }

        if (!jobResult?.playbackPaths?.length) {
          return call.id_list_message([{ type: 'text', data: 'השיר לא היה מוכן להשמעה. אפשר לנסות שוב.' }]);
        }
        console.info('[SONG] SONG_PLAYBACK_STARTED', { callId, songId: jobResult.id, files: jobResult.playbackPaths.length });
        const saved = jobResult.ext7 ? ' הוא נשמר גם בשלוחה שבע, השירים החדשים.' : '';
        return call.id_list_message([
          { type: 'text', data: say('השיר ' + (jobResult.spec?.title ? '"' + jobResult.spec.title + '" ' : '') + 'מוכן.' + saved + ' הנה הוא.') },
          ...jobResult.playbackPaths.map(file => ({ type: 'file', data: file })),
          { type: 'text', data: say('תודה. ליצירת שיר נוסף התקשרו שוב לשלוחה ארבע.') }
        ], { removeInvalidChars: true });
      }
    } catch (error) {
      if (error instanceof ExitError) throw error; // normal end: a message was sent / went to a folder
      if (isHangup(error)) return;
      logDetailedError('Song IVR', error);
      noteSongEvent('ivr_crash', { message: String(error?.message || error).slice(0, 200), where: String(error?.stack || '').split('\n')[1]?.trim().slice(0, 160) || '' });
      return call.id_list_message([{ type: 'text', data: say('מצטער, הייתה תקלה זמנית ביצירת השיר. אפשר לנסות שוב.') }]);
    }
  };
}
