const E='https://ext2.176-97-205-41.sslip.io';
for(let k=0;k<3;k++){ const r=await fetch(E+'/server-resources').then(r=>r.json()).catch(e=>({err:String(e)}));
 console.log('\n',r.at,'load',r.load,'cpu',r.cpuBusyPct,'avail',r.memMB?.available,'disk',r.disk?.[0]?.usePct,'tmp',JSON.stringify(r.tmpBig));
 for(const [n,g] of (r.groups||[]).slice(0,8)) console.log('  ',n,JSON.stringify(g));
 for(const p of (r.topCpu||[]).slice(0,8)) console.log('   cpu',p.cpu,p.rssMB,p.ageMin+'m',p.name,p.cmd.slice(0,150));
 await new Promise(r=>setTimeout(r,40000)); }
