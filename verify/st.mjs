const M='https://main.176-97-205-41.sslip.io';
for(let i=0;i<30;i++){ const r=await fetch(M+'/owner-report/570c9b4dde4cb61a14d13f68').catch(()=>null); if(r&&r.ok){ console.log(await r.text()); process.exit(0);} await new Promise(x=>setTimeout(x,20000)); }
console.log('no extract');
