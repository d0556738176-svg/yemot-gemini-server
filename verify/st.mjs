const E='https://ext2.176-97-205-41.sslip.io';
const n=await fetch(E+'/news-status').then(r=>r.json()).catch(e=>({err:String(e)}));
const ch=n.status?.channels||{};
for(const [k,v] of Object.entries(ch)) if(v.topic==='3'||v.topic==='4') console.log(k, v.topic, JSON.stringify(v.feedTitles||{}), v.error||'', (v.latest||'').slice(0,50));
for(const [t,v] of Object.entries(n.topics||{})) console.log('topic',t,v.title,'files',v.files);
const q=n.status?.queue||[]; const by={}; for(const x of q) by[x.topic]=(by[x.topic]||0)+1; console.log('queue by topic',JSON.stringify(by),'working',JSON.stringify(n.status?.working||{}).slice(0,400));
