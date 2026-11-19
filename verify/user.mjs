// Read-only: the owner's latest downloads on extension 2 (no new downloads).
const BASE='https://ext2.176-97-205-41.sslip.io';
const d=await fetch(BASE+'/branch2-diag').then(r=>r.json()).catch(e=>({err:String(e)}));
console.log('version',d.commit,'started',d.startedAt);
console.log('webEvents',JSON.stringify((d.webEvents||[]).slice(-15),null,1));
console.log('browserEvents',JSON.stringify((d.browserEvents||[]).slice(-6),null,1));
const r=await fetch(BASE+'/branch2-saved?recent=1').then(r=>r.json()).catch(e=>({err:String(e)}));
console.log('recent',JSON.stringify({audio:r.audio,video:r.video,timings:r.timings,ext7Newest:r.ext7Newest},null,1));
const ids=[...new Set([...(r.audio||[]),...(r.video||[]),...(r.ext7Newest||[]).slice(0,4)].map(x=>x.id))];
for(const id of ids){ const s=await fetch(BASE+'/branch2-saved?id='+id,{signal:AbortSignal.timeout(300000)}).then(r=>r.json()).catch(e=>({err:String(e)}));
  console.log('\n#### '+id, JSON.stringify({phone:{files:s.phone?.files,dur:s.phone?.probe?.durationSec},ext7:s.ext7&&{file:s.ext7.file,exists:s.ext7.exists},audioCopyNames:s.audioCopyNames,audioCopy:(s.audioCopy||[]).map(c=>({path:c.path,size:c.size})),video:s.video&&{state:s.video.state,files:(s.video.files||[]).map(f=>({path:f.path,size:f.size}))},err:s.err||s.message},null,1)); }
