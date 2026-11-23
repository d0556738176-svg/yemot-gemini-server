const E='https://ext2.176-97-205-41.sslip.io';
const want=process.env.WANT||'';
for(let i=0;i<40;i++){ const d=await fetch(E+'/branch2-diag').then(r=>r.json()).catch(()=>({})); if(String(d.commit||'').startsWith(want)){console.log('running',d.commit,d.startedAt);break;} await new Promise(r=>setTimeout(r,30000)); }
const f=await fetch(E+'/branch2-saved?folders=1',{signal:AbortSignal.timeout(300000)}).then(r=>r.json()).catch(e=>({err:String(e)}));
for(const x of f.folders||[f]) console.log(JSON.stringify(x).slice(0,3500));
const s=await fetch(E+'/branch2-saved?id=wlCee0kJh3l',{signal:AbortSignal.timeout(300000)}).then(r=>r.json()).catch(e=>({err:String(e)}));
console.log('parts',JSON.stringify((s.audioCopy||[]).map(c=>[c.path,c.size])));
