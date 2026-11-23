const E='https://ext2.176-97-205-41.sslip.io';
const d=await fetch(E+'/branch2-diag').then(r=>r.json()).catch(e=>({err:String(e)}));
console.log('ext2',d.commit,d.startedAt);
for(const e of (d.downloadEvents||[]).slice(-40)) console.log(e.at,e.kind,e.id,e.ok,(e.code||''),String(e.message||e.saved||e.remote||e.file||e.title||'').slice(0,260));
console.log('webEvents',JSON.stringify((d.webEvents||[]).slice(-8).map(e=>[e.at,e.where,e.ok,e.engine,(e.message||'').slice(0,200)])));
const r=await fetch(E+'/branch2-saved?recent=1').then(r=>r.json()).catch(e=>({err:String(e)}));
console.log('recent',JSON.stringify({audio:r.audio,video:r.video,ext7Newest:(r.ext7Newest||[]).slice(0,6)}));
const ids=[...new Set((d.downloadEvents||[]).slice(-25).map(e=>e.id).filter(Boolean))].slice(-6);
for(const id of ids){ const s=await fetch(E+'/branch2-saved?id='+id,{signal:AbortSignal.timeout(300000)}).then(r=>r.json()).catch(e=>({err:String(e)}));
 console.log('\n#### '+id, JSON.stringify({ext7:s.ext7&&s.ext7.file,audioCopyNames:s.audioCopyNames,audioCopy:(s.audioCopy||[]).map(c=>({path:c.path,size:c.size})),video:s.video&&{state:s.video.state,subtitles:s.video.subtitles,files:(s.video.files||[]).map(f=>({path:f.path,size:f.size,exists:f.exists}))},err:s.err||s.message})); }
