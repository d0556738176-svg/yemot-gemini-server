const M='https://main.176-97-205-41.sslip.io', E='https://ext2.176-97-205-41.sslip.io';
console.log('start',JSON.stringify(await fetch(E+'/branch2-engine-test?q='+encodeURIComponent('שיעור הרב גלנטי')+'&n=1').then(r=>r.json()).catch(e=>String(e))));
for(let i=0;i<20;i++){ await new Promise(r=>setTimeout(r,15000)); const s=await fetch(M+'/web-search-status').then(r=>r.json()).catch(()=>({})); if((s.searches||[]).length){ console.log(JSON.stringify(s).replace(/[A-Za-z0-9_-]{24,}/g,'[x]').slice(0,2500)); break; } }
