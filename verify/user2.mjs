const E='https://ext2.176-97-205-41.sslip.io';
const f=await fetch(E+'/branch2-saved?folders=1',{signal:AbortSignal.timeout(300000)}).then(r=>r.json()).catch(e=>({err:String(e)}));
for(const x of f.folders||[]){ console.log('\n##',x.dir,x.count,JSON.stringify(x.byExt));
 const all=[...(x.first||[]),...(x.newest||[])];
 for(const e of all) console.log(' ',e.fileType,e.size,e.mtime,String(e.name).slice(0,70)); }
