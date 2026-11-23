const M='https://main.176-97-205-41.sslip.io', E='https://ext2.176-97-205-41.sslip.io';
for(const u of [E+'/branch2-diag',E+'/server-resources',M+'/web-search-status',E+'/health',M+'/health']){
 const r=await fetch(u,{signal:AbortSignal.timeout(60000)}).then(async r=>r.status+' '+(await r.text()).slice(0,300)).catch(e=>'ERR '+e); console.log(u.split('/').pop(),r.replace(/"keys":\[.*?\],/,'').slice(0,300)); }
