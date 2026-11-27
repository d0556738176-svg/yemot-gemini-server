const E='https://ext2.176-97-205-41.sslip.io';
const n=await fetch(E+'/news-status').then(r=>r.json()).catch(e=>({err:String(e)}));
const q=n.status?.queue||[]; const by={}; for(const x of q) by[x.topic]=(by[x.topic]||0)+1;
console.log('queue',JSON.stringify(by),'working',JSON.stringify(n.status?.working||{}));
console.log(JSON.stringify(q.slice(0,12)));
console.log('log',JSON.stringify((n.status?.log||[]).slice(-15)));
for(const [t,v] of Object.entries(n.topics||{})) console.log('topic',t,'files',v.files,(v.newest||[]).slice(0,1).map(x=>x.file+' '+x.title.slice(0,30)).join());
