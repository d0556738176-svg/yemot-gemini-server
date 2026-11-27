const E='https://ext2.176-97-205-41.sslip.io';
for(let i=0;i<30;i++){ const r=await fetch(E+'/lobby-probe').catch(()=>null); if(r&&r.status===200){ const j=await r.json(); if(j.chunks===undefined && !j.error){ await new Promise(x=>setTimeout(x,20000)); continue; } console.log(JSON.stringify(j,null,1).slice(0,12000)); process.exit(0);} await new Promise(x=>setTimeout(x,20000)); }
console.log('no probe');
