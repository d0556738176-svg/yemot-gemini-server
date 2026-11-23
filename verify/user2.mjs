const E='https://ext2.176-97-205-41.sslip.io';
const want=process.env.WANT||'';
for(let i=0;i<40;i++){ const d=await fetch(E+'/branch2-diag').then(r=>r.json()).catch(()=>({})); if(String(d.commit||'').startsWith(want)){console.log('running',d.commit,d.startedAt);break;} await new Promise(r=>setTimeout(r,30000)); }
for(const q of ['K14GL_ucT44','K14GL_ucT44&subs=1','wyjtEfoO4SY','wlCee0kJh3l']){
 const r=await fetch(E+'/branch2-saved?probe='+q,{signal:AbortSignal.timeout(300000)}).then(r=>r.json()).catch(e=>({err:String(e)}));
 console.log(q,JSON.stringify(r)); await new Promise(r=>setTimeout(r,4000)); }
