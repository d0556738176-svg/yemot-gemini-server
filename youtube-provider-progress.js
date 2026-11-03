// Read only explicit byte/percentage reports. Time elapsed is never progress.
export function parseProviderProgress(logText) {
  let sample=null;
  for(const raw of String(logText||'').split(/\r?\n/)){
    const line=raw.replace(/\x1b\[[0-9;]*m/g,'');
    const aria=line.match(/\[#([a-z0-9]+)\s+[^\n]*?\((\d+(?:\.\d+)?)%\)/i);
    const ytdlp=line.match(/\[download\]\s+(\d+(?:\.\d+)?)%\s+of\s/i);
    if(aria||ytdlp){
      const n=Number(aria?aria[2]:ytdlp[1]);
      if(Number.isFinite(n)&&n>=0&&n<=100){
        const timestamp=line.match(/\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?Z/)?.[0];
        sample={percent:Math.min(99,Math.floor(n)),observedAt:timestamp||null,transferId:aria?.[1]||null};
      }
    } else if(/\berror\b|download (?:failed|stalled|too slow)|retrying|fallback|extracting URL|starting (?:new )?download/i.test(line)&&
      !/If there are any errors/i.test(line))sample=null;
  }
  return sample;
}

export async function boundedLogText(response,maxBytes=2*1024*1024){
  if(!response.body)return '';
  const reader=response.body.getReader(),decoder=new TextDecoder();let bytes=0,text='';
  try{
    for(;;){const {value,done}=await reader.read();if(done)break;
      bytes+=value.byteLength;
      if(bytes>maxBytes){await reader.cancel();throw Error('provider log too large');}
      text=(text+decoder.decode(value,{stream:true})).slice(-100000);
    }
    return text+decoder.decode();
  }finally{reader.releaseLock();}
}

// The native engine (johnvc) prints no byte/percent progress while it
// downloads. It does print one line when each download route attempt ends:
//   "Fetch path: <id> r1c1 attempt 2/6 status=blocked secs=1.4"
//   "Fetch path: <id> r1c1 attempt 3/6 status=ok mb=21.9 secs=563.3"
// Those are real facts the caller can be told (never turned into a %).
export function parseNativeAttempts(logText) {
  let finished = 0, max = null, blocked = 0, last = null, deliveredMb = null;
  for (const raw of String(logText || '').split(/\r?\n/)) {
    const m = raw.match(/Fetch path:\s+\S+\s+\S+\s+attempt\s+(\d+)\/(\d+)\s+status=([a-z_]+)(?:.*?\bmb=(\d+(?:\.\d+)?))?/i);
    if (!m) continue;
    finished = Math.max(finished, Number(m[1]));
    max = Number(m[2]);
    last = m[3].toLowerCase();
    if (last === 'blocked') blocked++;
    if (last === 'ok' && m[4]) deliveredMb = Number(m[4]);
  }
  if (!finished) return null;
  return { finished, max, blocked, last, deliveredMb,
    // The attempt running now (the one after the last finished one).
    current: last === 'ok' ? finished : Math.min(max || finished + 1, finished + 1) };
}
