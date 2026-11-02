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
