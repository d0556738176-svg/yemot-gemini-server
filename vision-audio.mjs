import {open,rm} from 'node:fs/promises';

const LIMIT = 32 * 1024 * 1024;
const PLAYER_URL = 'https://www.youtube.com/youtubei/v1/player?prettyPrint=false';
// Every failure carries a stable `code` so callers can tell a YouTube
// access refusal (login/bot check) apart from network, size or format errors.
export function visionError(code, message) {
  return Object.assign(new Error(message), {code});
}
function classifyPlayability(status) {
  if (status === 'LOGIN_REQUIRED') return 'youtube_login_required';
  if (status === 'AGE_CHECK_REQUIRED' || status === 'CONTENT_CHECK_REQUIRED') return 'youtube_age_restricted';
  if (status === 'UNPLAYABLE' || status === 'ERROR') return 'youtube_unplayable';
  return 'youtube_unavailable';
}

const CLIENT = {clientName:'VISIONOS',clientVersion:'1.02',deviceMake:'Apple',deviceModel:'RealityDevice17,1',osName:'visionOS',osVersion:'26.5.23O471',hl:'he'};

export async function downloadVisionAudio(id, destination, options={}) {
  try {
    return await downloadVisionAudioInner(id, destination, options);
  } catch (error) {
    if (error?.code) throw error;
    if (error?.name === 'TimeoutError' || error?.name === 'AbortError') throw visionError('timeout', 'Vision audio timed out');
    throw Object.assign(error instanceof Error ? error : new Error(String(error)), {code: 'network'});
  }
}

async function downloadVisionAudioInner(id, destination, {fetchImpl=fetch, maxBytes=LIMIT, timeoutMs=30000, signal:outerSignal}={}) {
  if (!/^[A-Za-z0-9_-]{11}$/.test(id)) throw new Error('Invalid video ID');
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1) throw new Error('Invalid maximum size');
  const signal=outerSignal?AbortSignal.any([outerSignal,AbortSignal.timeout(timeoutMs)]):AbortSignal.timeout(timeoutMs);
  const player=await fetchImpl(PLAYER_URL,{method:'POST',redirect:'error',signal,
    headers:{'content-type':'application/json','X-YouTube-Client-Name':'101','X-YouTube-Client-Version':CLIENT.clientVersion},
    body:JSON.stringify({context:{client:CLIENT},videoId:id,contentCheckOk:true,racyCheckOk:true})});
  if (!player.ok) throw visionError(player.status===429?'youtube_rate_limited':player.status===403?'youtube_forbidden':'youtube_player_http','Player request failed: HTTP '+player.status);
  const body=await player.json();
  if(body.playabilityStatus?.status!=='OK') {
    const code = String(body.playabilityStatus?.status || 'UNKNOWN');
    const safeCode = /^[A-Z_]{1,40}$/.test(code) ? code : 'UNKNOWN';
    throw visionError(classifyPlayability(safeCode),'Video unavailable: ' + safeCode);
  }
  const formats=(body.streamingData?.adaptiveFormats||[]).filter(f=>typeof f.url==='string' && /^audio\/mp4(?:;|$)/i.test(f.mimeType||'') && !f.isDrc && !/[?&]xtags=[^&]*drc/.test(f.url))
    .sort((a,b)=>(Number(b.bitrate)||0)-(Number(a.bitrate)||0));
  if(!formats.length) throw visionError('no_audio_format','No direct audio available');
  const audio=formats[0], u=new URL(audio.url);
  if(u.protocol!=='https:' || !u.hostname.endsWith('.googlevideo.com') || u.username || u.password || (u.port && u.port!=='443')) throw visionError('untrusted_source','Untrusted audio source');
  const expected=Number(audio.contentLength);
  if(!Number.isSafeInteger(expected) || expected<1 || expected>maxBytes) throw visionError(expected>maxBytes?'too_large':'invalid_length','Invalid audio length');
  const response=await fetchImpl(u,{redirect:'error',signal,headers:{'Accept-Encoding':'identity'}});
  if(!response.ok || !response.body) throw visionError(response.status===429?'youtube_rate_limited':response.status===403?'youtube_forbidden':'media_http','Audio request failed: HTTP '+response.status);
  const encoding=response.headers.get('content-encoding');
  if(encoding && encoding!=='identity') throw visionError('bad_encoding','Unexpected encoding');
  const declared=response.headers.get('content-length');
  if(declared!==null && Number(declared)!==expected) throw visionError('length_mismatch','Audio length mismatch');
  const file=await open(destination,'wx');
  let count=0;
  try {
    const reader=response.body.getReader();
    try {
      for(;;) {
        const {done,value}=await reader.read();
        if(done) break;
        count+=value.byteLength;
        if(count>expected) throw visionError('length_mismatch','Audio exceeded expected size');
        let offset=0;
        while(offset<value.byteLength) {
          const result=await file.write(value,offset,value.byteLength-offset);
          if(!result.bytesWritten) throw new Error('Write failed');
          offset+=result.bytesWritten;
        }
      }
    } finally {reader.releaseLock();}
    if(count!==expected) throw visionError('incomplete','Incomplete audio');
    await file.close();
    return {bytes:count};
  } catch(error) {
    await file.close().catch(()=>{});
    await rm(destination,{force:true}).catch(()=>{});
    throw error;
  }
}
