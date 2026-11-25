// Live check of extension 4: one whole song (owner check, branch 4).
const M='https://main.176-97-205-41.sslip.io';
const name=String(process.env.Q||'').trim();
const want=process.env.WANT||'';
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
for(let i=0;i<60;i++){ const v=await fetch(M+'/version').then(r=>r.json()).catch(()=>({})); if(String(v.running||'').startsWith(want)){console.log('main version',v.running,v.startedAt);break;} if(i==59) console.log('version',JSON.stringify(v)); await sleep(20000); }
if(!name){ process.exit(0); }
let started='';
for(let i=0;i<40;i++){ const r=await fetch(M+'/owner-check/'+name); if(r.ok){ started=await r.text(); break; } await sleep(20000); }
console.log(started||'check file never arrived');
if(!started) process.exit(0);
let last='';
for(let i=0;i<200;i++){ await sleep(20000); const r=await fetch(M+'/owner-report/'+name); if(r.ok){ last=await r.text(); if(/\n\+\d+s (done|FAILED)/.test(last)) break; } }
console.log(last);
const h=await fetch(M+'/health/songs').then(r=>r.text()).catch(()=>''); console.log('songs health', h.slice(0,2500));
