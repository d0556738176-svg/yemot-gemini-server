const M='https://main.176-97-205-41.sslip.io';
const r=await fetch(M+'/health/providers',{signal:AbortSignal.timeout(120000)}).then(r=>r.text()).catch(e=>String(e));
console.log(r.replace(/[A-Za-z0-9_-]{30,}/g,'[x]').slice(0,6000));
