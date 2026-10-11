import { createSong } from './song-generator.js';

const SONG_WAIT_TIMEOUT_MS = Number(process.env.SONG_WAIT_PROMPT_TIMEOUT_MS || 15000);

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
    let prompt = 'ברוכים הבאים ליוצר השירים. אמור איזה שיר תרצה ליצור, למשל שיר קצבי לנסיעה בלילה, ולסיום ההקלטה הקש סולמית.';
    let transcript = '';
    let pendingRequest = '';
    let awaitingClarification = false;
    let clarificationCount = 0;

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
          prompt = 'לא הצלחתי להבין את הבקשה. אמור בקצרה איזה שיר תרצה, ולסיום הקש סולמית.';
          continue;
        }

        let jobDone = false;
        let jobResult = null;
        let jobError = null;
        const jobPromise = createSong({
          prompt: transcript,
          callId,
          userKey: caller === 'לא מזוהה' ? callId : caller,
          generateText,
          onStatus: state => console.info('[SONG] JOB_STATUS', { callId, status: state.status })
        }).then(result => {
          jobDone = true;
          jobResult = result;
        }).catch(error => {
          jobDone = true;
          jobError = error;
        });

        while (!jobDone) {
          // Yemot's read action is the only reliable way to keep the caller on
          // this IVR request while work is happening. The prompt is repeated
          // periodically; a short recording is ignored while the job continues.
          try {
            const waitRecord = await call.read(
              [{ type: 'text', data: say('התחלתי ליצור את השיר שלך. זה עשוי לקחת כמה רגעים. אם השיר עדיין לא מוכן, המתן על הקו.') }],
              'record',
              { min_length: 1, max_length: 4, no_confirm_menu: true, timeout: SONG_WAIT_TIMEOUT_MS }
            );
            if (waitRecord && waitRecord !== 'None') {
              console.info('[SONG] WAIT_INPUT_IGNORED', { callId });
            }
          } catch (waitError) {
            const message = String(waitError?.message || waitError).toLowerCase();
            if (/hang.?up|disconnected|socket hang up|connection closed/.test(message)) {
              console.info('[SONG] CALL_DISCONNECTED', { callId });
              return;
            }
            if (/timeout|timed out|no input|recording timeout/.test(message)) {
              console.info('[SONG] STATUS_POLL_TIMEOUT', { callId });
              continue;
            }
            logDetailedError('Song status prompt', waitError);
            throw waitError;
          }
        }
        await jobPromise;

        if (jobError) {
          if (jobError.code === 'NEEDS_CLARIFICATION' && clarificationCount < 1) {
            clarificationCount++;
            prompt = String(jobError.message || 'איזה סגנון מוזיקלי תרצה?');
            continue;
          }
          const message = jobError.code === 'RATE_LIMITED'
            ? 'כבר יצרת את מספר השירים המרבי לשעה. אפשר לנסות שוב מאוחר יותר.'
            : 'מצטער, הייתה תקלה זמנית ביצירת השיר. אפשר לנסות שוב מאוחר יותר.';
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
          prompt = say(jobResult.clarificationQuestion || 'איזה סגנון מוזיקלי תרצה?');
          continue;
        }

        if (!jobResult?.playbackPaths?.length) {
          return call.id_list_message([{ type: 'text', data: 'השיר לא היה מוכן להשמעה. אפשר לנסות שוב.' }]);
        }
        console.info('[SONG] SONG_PLAYBACK_STARTED', {
          callId, songId: jobResult.id, files: jobResult.playbackPaths.length
        });
        return call.id_list_message([
          { type: 'text', data: say('השיר מוכן. אני משמיע אותו עכשיו.') },
          ...jobResult.playbackPaths.map(file => ({ type: 'file', data: file }))
        ], { removeInvalidChars: true });
      }
    } catch (error) {
      logDetailedError('Song IVR', error);
      const message = /hang.?up|disconnected|socket hang up|connection closed/i.test(String(error?.message || error))
        ? null
        : 'מצטער, הייתה תקלה זמנית ביצירת השיר. אפשר לנסות שוב.';
      if (!message) return;
      return call.id_list_message([{ type: 'text', data: say(message) }]);
    }
  };
}
