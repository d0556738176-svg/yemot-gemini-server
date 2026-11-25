const M='https://main.176-97-205-41.sslip.io';
for(let i=0;i<30;i++){ const r=await fetch(M+'/owner-report/e843b01e41ef09cf7e0ab36b').catch(()=>null); if(r&&r.ok){ console.log(await r.text()); process.exit(0);} await new Promise(x=>setTimeout(x,20000)); }
console.log('no extract');
