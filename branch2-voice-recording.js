import { randomInt } from 'node:crypto';

const marker = 'branch2_voice_work=yes';
const missing = /not.?found|not.?exist|doesn.t exist|לא קיים|אינו קיים|לא נמצא|לא נמצאה/i;
export function recordingFolder(now = new Date()) {
  return '/2/voice-input/' + now.toISOString().slice(0, 13).replace(/[-T]/g, '');
}
export function validRecording(data) {
  const b = Buffer.isBuffer(data) ? data : data instanceof Uint8Array ? Buffer.from(data) : null;
  if (!(b && b.length > 44 && b.toString('ascii', 0, 4) === 'RIFF' &&
    b.toString('ascii', 8, 12) === 'WAVE' && b.readUInt32LE(4) === b.length - 8)) return false;
  for (let off = 12; off + 8 <= b.length;) {
    const size = b.readUInt32LE(off + 4);
    if (b.toString('ascii', off, off + 4) === 'data') return size > 0 && off + 8 + size <= b.length;
    off += 8 + size + size % 2;
  }
  return false;
}

// Observed live: Yemot returned PCM payload with data length 0 and RIFF size 52.
// Recover only this unfinished-header case, without changing the audio samples.
export function repairRecordingWav(data) {
  if (!Buffer.isBuffer(data) || data.length <= 44 || data.toString('ascii', 0, 4) !== 'RIFF' ||
    data.toString('ascii', 8, 12) !== 'WAVE') return data;
  let pcm = false;
  for (let off = 12; off + 8 <= data.length;) {
    const kind = data.toString('ascii', off, off + 4), size = data.readUInt32LE(off + 4);
    if (kind === 'fmt ' && size >= 16 && off + 24 <= data.length)
      pcm = data.readUInt16LE(off + 8) === 1 && data.readUInt16LE(off + 22) === 16;
    if (kind === 'data') {
      const actual = data.length - off - 8;
      if (pcm && actual > 0 && actual % 2 === 0 && (size === 0 || size === 0xffffffff)) {
        const repaired = Buffer.from(data);
        repaired.writeUInt32LE(repaired.length - 8, 4);
        repaired.writeUInt32LE(actual, off + 4);
        return repaired;
      }
      return data;
    }
    off += 8 + size + size % 2;
  }
  return data;
}

// Keep transient caller recordings out of /2's 000..999 media namespace.
// A unique explicit filename also prevents two simultaneous calls colliding.
export function createVoiceRecorder({ api, download, log = console, wait = ms => new Promise(r => setTimeout(r, ms)) }) {
  const ready = new Map();
  async function prepare(folder = recordingFolder()) {
    if (!ready.has(folder)) {
      const work = (async () => {
        const what = 'ivr2:' + folder + '/ext.ini';
        const old = await api('GetTextFile', { what });
        if (old.responseStatus === 'OK' && !String(old.contents || '').includes(marker))
          throw Object.assign(Error('Recording work folder has another purpose'), { code: 'recording_storage' });
        if (old.responseStatus !== 'OK' && !missing.test(String(old.message || '')))
          throw Object.assign(Error('Cannot inspect recording work folder'), { code: 'recording_storage' });
        if (old.responseStatus !== 'OK') {
          const written = await api('UploadTextFile', { what, contents: 'type=go_to_folder\ngo_to_folder=/2\n' + marker + '\n' });
          if (written.responseStatus !== 'OK') throw Object.assign(Error('Cannot create recording work folder'), { code: 'recording_storage' });
          const checked = await api('GetTextFile', { what });
          if (checked.responseStatus !== 'OK' || !String(checked.contents || '').includes(marker))
            throw Object.assign(Error('Cannot verify recording work folder'), { code: 'recording_storage' });
        }
        return folder;
      })().catch(e => { ready.delete(folder); throw e; });
      ready.set(folder, work);
      // Only the current/recent hourly folders need a process-local receipt.
      if (ready.size > 24) ready.delete(ready.keys().next().value);
    }
    return ready.get(folder);
  }
  async function capture(call, messages, sequence) {
    const folder = await prepare();
    const name = String(Date.now()) + String(randomInt(100000, 1000000));
    const expected = 'ivr2:' + folder + '/' + name + '.wav';
    const value = await call.read(messages, 'record', {
      path: folder, file_name: name, val_name: 'ytvoice' + sequence,
      min_length: 1, max_length: 60, no_confirm_menu: true, timeout: 10 * 60 * 1000
    });
    if (!value || String(value).trim() === 'None')
      throw Object.assign(Error('No recording returned'), { code: 'recording_empty' });
    const returned = String(value).trim().replace(/^ivr2:/, '');
    if ('ivr2:' + returned !== expected)
      throw Object.assign(Error('Unexpected recording location'), { code: 'recording_path' });
    let last;
    for (const delay of [0, 400, 1200]) {
      if (delay) await wait(delay);
      try {
        const response = await download(expected);
        const audio = repairRecordingWav(response?.data);
        if (!validRecording(audio))
          throw Object.assign(Error('Recording download is not WAV audio'), { code: 'recording_invalid' });
        const bytes = Buffer.from(audio);
        log.info?.('[YouTube IVR] voice recording ready', { bytes: bytes.length, repaired: audio !== response.data });
        // Only remove the new temporary file that this capture itself created.
        void api('FileAction', { action: 'delete', what: expected }).catch(() => {});
        return bytes;
      } catch (e) { last = e; }
    }
    throw last;
  }
  return { prepare, capture };
}
