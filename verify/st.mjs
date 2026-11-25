const M='https://main.176-97-205-41.sslip.io';
for (const p of ['/version','/health/usage','/health/search-local','/health/models']) {
  const t=await fetch(M+p,{signal:AbortSignal.timeout(90000)}).then(async r=>r.status+' '+await r.text()).catch(e=>'ERR '+e);
  console.log('=== '+p+'\n'+t.slice(0,7000));
}
