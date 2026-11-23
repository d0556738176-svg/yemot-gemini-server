// Live, no Yemot writes: wait for both new versions, run the engine check for a few searches
// (each found item is downloaded only until real media arrives, into a temp file), then report.
const E='https://ext2.176-97-205-41.sslip.io', M='https://main.176-97-205-41.sslip.io', WANT=process.env.WANT||'';
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
for(let i=0;i<60;i++){ const d=await fetch(E+'/branch2-diag').then(r=>r.json()).catch(()=>({})); if(String(d.commit||'').startsWith(WANT)){console.log('ext2 running',d.commit,d.startedAt);break;} await sleep(30000); }
console.log('res',JSON.stringify(await fetch(E+'/server-resources').then(r=>r.json()).then(r=>({load:r.load,cpu:r.cpuBusyPct,mem:r.memMB,disk:r.disk?.[0]?.usePct})).catch(e=>String(e))));
const Q=process.env.Q;
const t=await fetch(E+'/branch2-engine-test?n=4&q='+encodeURIComponent(Q)).then(r=>r.json()).catch(e=>({err:String(e)}));
console.log('trigger',JSON.stringify(t));
for(let i=0;i<120;i++){ await sleep(20000); const d=await fetch(E+'/branch2-diag').then(r=>r.json()).catch(()=>({})); if(d.engineTest?.status==='done'){ for(const s of d.engineTest.sites){ console.log('\n'+s.q+' candidates '+s.candidates+' ok '+s.found+(s.error?' ERR '+s.error:'')); for(const c of s.checked) console.log('  ',c.ok?'OK ':'NO ',c.host,c.engine||'',c.sec+'s',(c.title||'').slice(0,40),(c.why||'').slice(0,160)); }
  console.log('\nwebEvents',JSON.stringify((d.webEvents||[]).slice(-10).map(e=>[e.where,e.ok,e.engine,e.message||'']),null,1)); break; } }
const s=await fetch(M+'/web-search-status').then(r=>r.json()).catch(e=>({err:String(e)}));
console.log('\nsearch engines',JSON.stringify((s.searches||[]).slice(-4).map(x=>x.engines)));
