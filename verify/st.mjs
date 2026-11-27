const E='https://ext2.176-97-205-41.sslip.io';
const n=await fetch(E+'/news-status').then(r=>r.json()).catch(e=>({err:String(e)}));
const q=n.status?.queue||[]; const now=Date.now();
for(const t of ['1','5','2']){ const a=q.filter(x=>x.topic===t); const w={}; for(const x of a){const k=(x.wait||'new').slice(0,40); w[k]=(w[k]||0)+1;} console.log('topic',t,'queued',a.length,JSON.stringify(w),'oldest',a.map(x=>x.published).sort()[0]); }
console.log('working',JSON.stringify(n.status?.working||{}));
const log=(n.status?.log||[]); const done=log.filter(x=>x.done); console.log('done last',done.length, JSON.stringify(done.slice(-8).map(x=>[x.topic,x.seconds,x.lateMin])));
console.log('fails',JSON.stringify(log.filter(x=>x.failed||x.gaveUp||x.error).slice(-6)).slice(0,1500));
console.log('sample', JSON.stringify(q.filter(x=>x.topic==='1').slice(0,3)).slice(0,800));
