// Read-only health snapshot of the main server (no secrets are returned by these endpoints).
const M='https://main.176-97-205-41.sslip.io';
for (const p of ['/version','/health/models','/web-search-status','/health/search-local','/server-resources']) {
  const t=await fetch(M+p,{signal:AbortSignal.timeout(90000)}).then(async r=>r.status+' '+await r.text()).catch(e=>'ERR '+e);
  console.log('=== '+p+'\n'+t.slice(0,6000));
}
