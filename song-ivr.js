// Extension 4: AI song maker (owner, 12-13.11).
//
// The caller says what song he wants; the AI writes Hebrew lyrics; the free
// engine (official ACE-Step model on a GitHub runner) composes it. That takes
// minutes, so while waiting the caller hears an update about every half
// minute and may press 0 to leave for the main menu: the song keeps being
// made and is saved anyway in extension 7 ("the new songs"). If he stays,
// the song plays here as soon as it is ready.
import { ExitError, HangupError, TimeoutError } from 'yemot-router2';
import { createSong, warmMusicEngine, cloudJobStatus } from './song-generator.js';

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

export function createSongCallHandler({
  yemotApi,
  transcribePhoneAudio,
  generateText,
  sanitizeForYemot,
  withTimeout,
  getCallerNumber,
  logDetailedError
}) {
  return async function songCallHandler(call) {
    const callId = String(call?.callId || call?.values?.ApiCallId || ('song-' + Date.now()));
    const caller = getCallerNumber(call);
    const say = value => sanitizeForYemot(value);
    let prompt = 'ברוכים הבאים ליוצר השירים. אמרו על מה השיר ובאיזה סגנון, למשל שיר שמח לכבוד שבת עם גיטרה. בסיום הדיבור הקישו סולמית.';
    let transcript = '';
    let pendingRequest = '';
    let awaitingClarification = false;
    let clarificationCount = 0;
    warmMusicEngine();

    try {
      while (true) {
        const recordPath = await call.read(
          [{ type: 'text', data: say(prompt) }],
          'record',
          { min_length: 1, max_length: 60, no_confirm_menu: true, timeout: 10 * 60 * 1000 }
        );
        if (!recordPath || recordPath === 'None') {
          return call.id_list_message([{ type: 'text', data: 'לא נקלטה בקשה. אפשר להתקשר שוב ולנסות ליצור שיר.' }]);
        }

        const response = await withTimeout(
          yemotApi.download_file('ivr2:' + recordPath),
          Number(process.env.REQUEST_TIMEOUT_MS || 30000),
          'song request recording download'
        );
        transcript = String(await transcribePhoneAudio(response.data) || '').trim();
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
          return call.id_list_message([{ type: 'text', data: say(message) }]);
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
      return call.id_list_message([{ type: 'text', data: say('מצטער, הייתה תקלה זמנית ביצירת השיר. אפשר לנסות שוב.') }]);
    }
  };
}
