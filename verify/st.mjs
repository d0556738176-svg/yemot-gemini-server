const M='https://main.176-97-205-41.sslip.io';
const r=await fetch(M+'/health/providers',{signal:AbortSignal.timeout(120000)}).then(r=>r.json()).catch(e=>({err:String(e)}));
console.log(JSON.stringify(r.providers?.serper||r), JSON.stringify(r.providers?.langsearch||{}));
const s=await fetch(M+'/web-search-status').then(r=>r.json()).catch(e=>({err:String(e)}));
console.log(JSON.stringify((s.searches||[]).slice(-5).map(x=>[x.at,x.items,x.engines?.videos,x.engines?.web,JSON.stringify(x.engines?.serperCodes||{})])));
