const M='https://main.176-97-205-41.sslip.io';
const s=await fetch(M+'/web-search-status',{signal:AbortSignal.timeout(120000)}).then(r=>r.text()).catch(e=>String(e));
console.log(s.replace(/[A-Za-z0-9_-]{24,}/g,'[x]').slice(0,3000));
