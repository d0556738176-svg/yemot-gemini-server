const BASE='https://ext2.176-97-205-41.sslip.io', WANT=process.env.WANT||'';
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
for(let i=0;i<100;i++){const d=await fetch(BASE+'/branch2-diag').then(r=>r.json()).catch(()=>({}));console.log('version',d.commit);if(String(d.commit||'').startsWith(WANT))break;await sleep(20000);}
let r=null;
for(let i=0;i<40;i++){ r=await fetch(BASE+'/branch2-saved?recent=1').then(r=>r.json()).catch(()=>null); if(r?.ext7CatchUp)break; await sleep(30000); }
console.log(JSON.stringify(r,null,1));
for(const id of (r?.ext7CatchUp?.added||[]).slice(-3)){ const s=await fetch(BASE+'/branch2-saved?id='+id,{signal:AbortSignal.timeout(300000)}).then(r=>r.json()).catch(e=>({err:String(e)})); console.log('\n#### '+id, JSON.stringify({phone:{files:s.phone?.files,dur:s.phone?.probe?.durationSec,peak:s.phone?.peakDb},ext7:s.ext7,audioCopy:(s.audioCopy||[]).map(c=>({path:c.path,size:c.size,dur:c.probe?.durationSec}))},null,1)); }
