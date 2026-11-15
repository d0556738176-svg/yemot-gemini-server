// Phone recording downloads use GET: the legacy library download route can return HTTP 500.
export function recordingPath(value) {
  const raw = String(value ?? '').trim().replace(/^(?:ivr2:)+/i, '');
  if (!raw || /[\x00-\x1f?#]/.test(raw) || raw.includes('://') || raw.split('/').includes('..'))
    throw new Error('Invalid recording path');
  return 'ivr2:/' + raw.replace(/^\/+/, '');
}
export async function downloadPhoneRecording(value, {
  fetchImpl = globalThis.fetch,
  env = process.env,
  timeoutMs = 5500,
  attempts = 2
} = {}) {
  const path = recordingPath(value);
  const user = String(env.YEMOT_API_USERNAME || '').trim();
  const password = String(env.YEMOT_API_PASSWORD || '').trim();
  if (!user || !password) throw new Error('Recording download credentials are missing');
  const url = new URL('https://www.call2all.co.il/ym/api/DownloadFile');
  url.search = new URLSearchParams({token: user + ':' + password, path}).toString();
  const deadline = Date.now() + timeoutMs;
  let last;
  for (let i = 0; i < attempts; i++) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) break;
    let retryable = true;
    try {
      const response = await fetchImpl(url, {
        method: 'GET', redirect: 'error',
        signal: AbortSignal.timeout(Math.max(1, remaining))
      });
      if (!response.ok) {
        retryable = response.status >= 500 || [404, 408, 429].includes(response.status);
        await response.body?.cancel();
        throw new Error('Recording download HTTP ' + response.status);
      }
      const data = Buffer.from(await response.arrayBuffer());
      const riff = data.subarray(0, 4).toString() === 'RIFF' && data.subarray(8, 12).toString() === 'WAVE';
      const mp3 = data.subarray(0, 3).toString() === 'ID3' || (data[0] === 255 && (data[1] & 224) === 224);
      if (data.length < 44 || (!riff && !mp3)) throw new Error('Recording download returned invalid audio');
      return {data};
    } catch (e) {
      // Never include URL, token, response body or provider error text in logs.
      last = new Error(e?.message?.startsWith('Recording download ') ? e.message : 'Recording download network failure');
      if (!retryable || i + 1 >= attempts || deadline - Date.now() <= 250) break;
      await new Promise(resolve => setTimeout(resolve, 200));
    }
  }
  throw last || new Error('Recording download timed out');
}
