const M='https://main.176-97-205-41.sslip.io', E='https://ext2.176-97-205-41.sslip.io';
const want=process.env.WANT||'';
// resources right away (old version has no endpoint), then after deploy
console.log('start',JSON.stringify(await fetch(E+'/branch2-engine-test?q='+encodeURIComponent('שיר אברהם פריד')+'&n=1').then(r=>r.json()).catch(e=>String(e))));
for(let i=0;i<20;i++){ await new Promise(r=>setTimeout(r,15000)); const s=await fetch(M+'/web-search-status').then(r=>r.json()).catch(()=>({})); const l=s.searches||[]; if(l.length&&Date.parse(l.at(-1).at)>Date.now()-300000){ console.log('SEARCH',JSON.stringify(l.slice(-2))); break; } }
for(let i=0;i<40;i++){ const d=await fetch(E+'/branch2-diag').then(r=>r.json()).catch(()=>({})); if(String(d.commit||'').startsWith(want)){console.log('running',d.commit,d.startedAt);break;} await new Promise(r=>setTimeout(r,30000)); }
for(let k=0;k<3;k++){ const r=await fetch(E+'/server-resources').then(r=>r.json()).catch(e=>({err:String(e)})); console.log('\nRES',JSON.stringify(r)); await new Promise(r=>setTimeout(r,60000)); }
