// Live conversation check of extension 1/3 (one simulated call, phone 0000000009).
const M='https://main.176-97-205-41.sslip.io';
const name=String(process.env.Q||'').trim();
const want=process.env.WANT||'';
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
const contains=async run=>{ if(!want||String(run).startsWith(want))return true; const c=await fetch('https://api.github.com/repos/d0556738176-svg/yemot-gemini-server/compare/'+want+'...'+run).then(r=>r.json()).catch(()=>({})); return c.status==='ahead'||c.status==='identical'; };
for(let i=0;i<90;i++){ const v=await fetch(M+'/version').then(r=>r.json()).catch(()=>({})); const c=v.running||''; if(c&&await contains(c)){console.log('main version',c);break;} await sleep(20000); }
let started='';
for(let i=0;i<40;i++){ const r=await fetch(M+'/owner-check/'+name); if(r.ok){ started=await r.text(); break; } await sleep(20000); }
console.log(started||'check file never arrived');
if(!started) process.exit(0);
let last='';
for(let i=0;i<90;i++){ await sleep(20000); const r=await fetch(M+'/owner-report/'+name); if(r.ok){ const t=await r.text(); if(t===last && i>3){ console.log(t); break; } last=t; } }
console.log(last);
