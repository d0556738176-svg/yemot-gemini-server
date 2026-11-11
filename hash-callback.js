// Owner's request (11.11): pressing # in the main menu hangs up and the system
// calls the caller straight back (Yemot "system_sharing to myself"), so the rest
// of the call runs on the system's line instead of the caller's minutes.
//
// Yemot wiring:
//  - ivr2:/ext.ini            gets hash_extension=yes (the menu sends # to the Hash folder)
//  - ivr2:/Hash/ext.ini       type=system_sharing, to the caller himself, from the number he dialed
//  - ivr2:/Hash/M6306.wav     the "sharing done" message replaced by "מיד תקבלו שיחה חוזרת"
// The callback lands in the main menu like a normal call; it is triggered only
// by pressing #, so it can never loop on its own.
import { synthesize } from './edge-tts.js';

const API = 'https://www.call2all.co.il/ym/api';
const log = (...a) => console.info('[HASH_CALLBACK]', ...a);
const VOICE = process.env.HASH_CALLBACK_VOICE || 'he-IL-AvriNeural';
const MESSAGE = 'מיד תקבלו שיחה חוזרת. אפשר לנתק.';
export const HASH_INI = [
  'type=system_sharing',
  'title=שיחה חוזרת',
  'system_sharing_to_myself=yes',
  'system_sharing_custom_did=real_did',
].join('\n') + '\n';

function token() {
  const t = String(process.env.YEMOT_TOKEN || '').trim();
  if (t) return t;
  const u = String(process.env.YEMOT_API_USERNAME || '').trim(), p = String(process.env.YEMOT_API_PASSWORD || '').trim();
  return u && p ? u + ':' + p : '';
}
async function api(name, params, method = 'GET') {
  const body = new URLSearchParams({ token: token(), ...params });
  const r = method === 'GET'
    ? await fetch(API + '/' + name + '?' + body, { signal: AbortSignal.timeout(20000) })
    : await fetch(API + '/' + name, { method, body, signal: AbortSignal.timeout(20000) });
  return r.json().catch(() => null);
}
const getText = async what => { const j = await api('GetTextFile', { what }); return j?.responseStatus === 'OK' ? String(j.contents ?? '') : null; };
async function putText(what, contents) {
  const j = await api('UploadTextFile', { what, contents }, 'POST');
  if (j?.responseStatus !== 'OK') throw new Error('UploadTextFile ' + what + ': ' + (j?.message || 'failed'));
}

// Adds hash_extension=yes to the main menu settings, keeping every other line as is.
export function withHashExtension(ini) {
  const lines = String(ini || '').replace(/\r/g, '').split('\n').filter(l => l.trim() !== '');
  const rest = lines.filter(l => !/^\s*hash_extension\s*=/.test(l));
  return [...rest, 'hash_extension=yes'].join('\n') + '\n';
}

export async function setupHashCallback() {
  if (String(process.env.HASH_CALLBACK || 'on') === 'off') return log('disabled by HASH_CALLBACK=off');
  if (process.env.RENDER_SERVICE_NAME && process.env.RENDER_SERVICE_NAME !== 'yemot-gemini-server') return log('not the main service; skipping');
  if (!token()) return log('no Yemot credentials; skipping');

  const curHash = await getText('ivr2:/Hash/ext.ini');
  if (String(curHash || '').replace(/\r/g, '').trim() !== HASH_INI.trim()) {
    await putText('ivr2:/Hash/ext.ini', HASH_INI);
    log('callback folder set (was', JSON.stringify(String(curHash || '').slice(0, 200)) + ')');
  }

  // The spoken message, uploaded once (a marker file remembers the text).
  const marker = await getText('ivr2:/Hash/message.txt');
  if (String(marker || '').trim() !== MESSAGE) {
    try {
      const mp3 = await synthesize(MESSAGE, { voice: VOICE, rate: '-4%', timeoutMs: 25000 });
      const u = new URL(API + '/UploadFile');
      u.searchParams.set('token', token()); u.searchParams.set('path', 'ivr2:/Hash/M6306.wav');
      u.searchParams.set('convertAudio', '1'); u.searchParams.set('autoNumbering', 'false');
      const form = new FormData();
      form.append('file', new Blob([mp3], { type: 'audio/mpeg' }), 'M6306.mp3');
      const j = await (await fetch(u, { method: 'POST', body: form, signal: AbortSignal.timeout(60000) })).json().catch(() => null);
      if (j?.responseStatus !== 'OK') throw new Error(JSON.stringify(j).slice(0, 200));
      await putText('ivr2:/Hash/message.txt', MESSAGE);
      log('callback message uploaded');
    } catch (e) { log('message upload failed; Yemot default message stays', String(e?.message || e).slice(0, 200)); }
  }

  // On a fresh account the folder appears only with the first file in it, so
  // the settings are checked again (and written again) after the upload.
  for (let i = 0; i < 3; i++) {
    if (String(await getText('ivr2:/Hash/ext.ini') || '').replace(/\r/g, '').trim() === HASH_INI.trim()) break;
    await putText('ivr2:/Hash/ext.ini', HASH_INI);
    log('callback folder settings written again');
    await new Promise(r => setTimeout(r, 2000));
  }

  // Main menu last, so # never points at a folder that is not ready.
  const curMain = await getText('ivr2:/ext.ini');
  if (curMain === null) return log('could not read the main menu settings; # left unchanged');
  const want = withHashExtension(curMain);
  if (curMain.replace(/\r/g, '').trim() !== want.trim()) {
    await putText('ivr2:/ext.ini', want);
    log('main menu: # now opens the callback (was', JSON.stringify(curMain.slice(0, 200)) + ')');
  }
  const now = await getText('ivr2:/ext.ini');
  const rawHash = await api('GetTextFile', { what: 'ivr2:/Hash/ext.ini' });
  const dir = await api('GetIVR2Dir', { path: 'ivr2:/Hash' });
  log('verified', {
    mainMenu: String(now || '').replace(/\r/g, '').trim(),
    hash: JSON.stringify(rawHash).replace(/"token":"[^"]*"/, '').slice(0, 300),
    hashFolder: JSON.stringify({ status: dir?.responseStatus, msg: dir?.message, files: (dir?.files || []).map(f => f.name), ini: dir?.ini }).slice(0, 500),
  });
}
