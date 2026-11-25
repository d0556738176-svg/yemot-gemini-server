const M='https://main.176-97-205-41.sslip.io';
const j=await fetch(M+'/health/usage',{signal:AbortSignal.timeout(60000)}).then(r=>r.json());
console.log(JSON.stringify(j.days));
for(const x of j.gemini.slice(-40)) console.log(JSON.stringify(x));
