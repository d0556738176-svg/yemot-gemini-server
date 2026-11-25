const M='https://main.176-97-205-41.sslip.io';
for (const p of ['/health/search-local','/health/usage']) {
  const t=await fetch(M+p,{signal:AbortSignal.timeout(90000)}).then(async r=>r.status+' '+await r.text()).catch(e=>'ERR '+e);
  console.log('=== '+p+'\n'+t.slice(0,2500));
}
const E='https://ext2.176-97-205-41.sslip.io';
for (const p of ['/server-resources','/branch2-diag']) {
  const t=await fetch(E+p,{signal:AbortSignal.timeout(60000)}).then(async r=>r.status+' '+(await r.text()).slice(0,1500)).catch(e=>'ERR '+e);
  console.log('=== ext2 '+p+'\n'+t);
}
