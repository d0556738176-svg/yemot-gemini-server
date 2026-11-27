const E='https://ext2.176-97-205-41.sslip.io';
for(let i=0;i<30;i++){ const r=await fetch(E+'/lobby-probe').catch(()=>null); if(r&&r.status===200){ const j=await r.json(); for(const [k,v] of Object.entries(j)){ console.log('==',k,JSON.stringify({...v,around:undefined,scripts:(v.scripts||[]).length})); console.log((v.around||'').replace(/\s+/g,' ').slice(0,2200)); } process.exit(0);} await new Promise(x=>setTimeout(x,20000)); }
console.log('no probe');
