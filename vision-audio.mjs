import {open,rm} from 'node:fs/promises';

const LIMIT = 32 * 1024 * 1024;
const PLAYER_URL = 'https://www.youtube.com/youtubei/v1/player?prettyPrint=false';
const CLIENT = {clientName:'VISIONOS',clientVersion:'1.02',deviceMake:'Apple',deviceModel:'RealityDevice17,1',osName:'visionOS',osVersion:'26.5.23O471',hl:'he'};

export async function downloadVisionAudio(id, destination, {fetchImpl=fetch, maxBytes=LIMIT, timeoutMs=30000}={}) {
  if (!/^[A-Za-z0-9_-]{11}$/.test(id)) throw new Error('Invalid video ID');
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1) throw new Error('Invalid maximum size');
  const signal=AbortSignal.timeout(timeoutMs);
  const player=await fetchImpl(PLAYER_URL,{method:'POST',redirect:'error',signal,
    headers:{'content-type':'application/json','X-YouTube-Client-Name':'101','X-YouTube-Client-Version':CLIENT.clientVersion},
    body:JSON.stringify({context:{client:CLIENT},videoId:id,contentCheckOk:true,racyCheckOk:true})});
  if (!player.ok) throw new Error('Player request failed: HTTP '+player.status);
  const body=await player.json();
  if(body.playabilityStatus?.status!=='OK') {
    const code = String(body.playabilityStatus?.status || 'UNKNOWN');
    const safeCode = /^[A-Z_]{1,40}$/.test(code) ? code : 'UNKNOWN';
    throw new Error('Video unavailable: ' + safeCode);
  }
  const formats=(body.streamingData?.adaptiveFormats||[]).filter(f=>typeof f.url==='string' && /^audio\/mp4(?:;|$)/i.test(f.mimeType||'') && !f.isDrc && !/[?&]xtags=[^&]*drc/.test(f.url))
    .sort((a,b)=>(Number(b.bitrate)||0)-(Number(a.bitrate)||0));
  if(!formats.length) throw new Error('No direct audio available');
  const audio=formats[0], u=new URL(audio.url);
  if(u.protocol!=='https:' || !u.hostname.endsWith('.googlevideo.com') || u.username || u.password || (u.port && u.port!=='443')) throw new Error('Untrusted audio source');
  const expected=Number(audio.contentLength);
  if(!Number.isSafeInteger(expected) || expected<1 || expected>maxBytes) throw new Error('Invalid audio length');
  const response=await fetchImpl(u,{redirect:'error',signal,headers:{'Accept-Encoding':'identity'}});
  if(!response.ok || !response.body) throw new Error('Audio request failed: HTTP '+response.status);
  const encoding=response.headers.get('content-encoding');
  if(encoding && encoding!=='identity') throw new Error('Unexpected encoding');
  const declared=response.headers.get('content-length');
  if(declared!==null && Number(declared)!==expected) throw new Error('Audio length mismatch');
  const file=await open(destination,'wx');
  let count=0;
  try {
    const reader=response.body.getReader();
    try {
      for(;;) {
        const {done,value}=await reader.read();
        if(done) break;
        count+=value.byteLength;
        if(count>expected) throw new Error('Audio exceeded expected size');
        let offset=0;
        while(offset<value.byteLength) {
          const result=await file.write(value,offset,value.byteLength-offset);
          if(!result.bytesWritten) throw new Error('Write failed');
          offset+=result.bytesWritten;
        }
      }
    } finally {reader.releaseLock();}
    if(count!==expected) throw new Error('Incomplete audio');
    await file.close();
    return {bytes:count};
  } catch(error) {
    await file.close().catch(()=>{});
    await rm(destination,{force:true}).catch(()=>{});
    throw error;
  }
}
