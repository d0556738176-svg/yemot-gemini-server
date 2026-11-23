// Live, no Yemot writes: engine check (search, then each item downloaded only until real media arrives, into a temp file).
const E='https://ext2.176-97-205-41.sslip.io', M='https://main.176-97-205-41.sslip.io';
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
const batches=String(process.env.Q).split('||');
for(const Q of batches){
  let t;
  for(let k=0;k<30;k++){ t=await fetch(E+'/branch2-engine-test?n=2&q='+encodeURIComponent(Q)).then(r=>r.json()).catch(e=>({err:String(e)})); if(t.ok) break; await sleep(30000); }
  console.log('\n######## trigger',JSON.stringify(t));
  for(let i=0;i<150;i++){ await sleep(20000); const d=await fetch(E+'/branch2-diag').then(r=>r.json()).catch(()=>({})); if(d.engineTest?.status==='done'){ for(const s of d.engineTest.sites){ console.log('\n'+s.q+' | candidates '+s.candidates+' | ok '+s.found+(s.error?' ERR '+s.error:'')); for(const c of s.checked) console.log('  ',c.ok?'OK ':'NO ',c.host,c.engine||'',c.sec+'s',(c.title||'').slice(0,40),(c.why||'').slice(0,140)); } break; } }
}
const s=await fetch(M+'/web-search-status').then(r=>r.json()).catch(e=>({err:String(e)}));
console.log('\nsearch engines',JSON.stringify((s.searches||[]).slice(-14).map(x=>[x.items,x.engines.videos,x.engines.web,x.engines.onlySite||''])));
