const E='https://ext2.176-97-205-41.sslip.io';
const n=await fetch(E+'/news-status').then(r=>r.json()).catch(e=>({err:String(e)}));
const T=n.topics||{}; console.log('topics',Object.keys(T).length);
for(const [t,v] of Object.entries(T)) console.log(t,v.title,'files',v.files);
const S=n.settings||{}; console.log('settings dirs',Object.keys(S).length, JSON.stringify(S['/11/6']||null), JSON.stringify(S['/11/36']||null));
const ch=Object.values(n.status?.channels||{}); console.log('channels seen',ch.length,'with feed',ch.filter(c=>c.feedTitles&&Object.keys(c.feedTitles).length).length,'errors',ch.filter(c=>c.error).length);
const q=n.status?.queue||[]; const by={}; for(const x of q) by[x.topic]=(by[x.topic]||0)+1; console.log('queue',JSON.stringify(by));
