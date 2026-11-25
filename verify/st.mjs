const M='https://main.176-97-205-41.sslip.io';
for (const q of ['מחיר בנזין נובמבר 2026','הרב עובדיה יוסף','מזג האוויר בית שמש','python list tuple difference']) {
  const t=await fetch(M+'/health/search-local?q='+encodeURIComponent(q),{signal:AbortSignal.timeout(60000)}).then(r=>r.text()).catch(e=>'ERR '+e);
  console.log(q,'=>',t.slice(0,400)); await new Promise(r=>setTimeout(r,11000));
}
const r=await fetch('https://ext2.176-97-205-41.sslip.io/server-resources').then(r=>r.json()).catch(()=>({}));
console.log('mem',JSON.stringify(r.memMB),'load',JSON.stringify(r.load),'disk',r.disk?.[0]?.usePct);
console.log('top',JSON.stringify((r.topMem||[]).slice(0,6).map(x=>[x.name,x.rssMB,x.cmd?.slice(0,50)])));
