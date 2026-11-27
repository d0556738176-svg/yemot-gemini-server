const E='https://ext2.176-97-205-41.sslip.io';
const n=await fetch(E+'/news-status').then(r=>r.json()).catch(e=>({err:String(e)}));
const ch=n.status?.channels||{};
const miss=Object.entries(ch).filter(([k,v])=>(v.topic==='5'||v.topic==='1')&&!(v.feedTitles&&Object.keys(v.feedTitles).length)).map(([k,v])=>k+':'+(v.error||''));
console.log('missing',JSON.stringify(miss),'onedge',JSON.stringify(ch.onedge?.feedTitles||{}));
const t5=n.topics?.['5']||{}; console.log('topic5 files',t5.files); for(const x of (t5.newest||[]).slice(0,15)) console.log(' ',x.file,x.ch||'',x.title?.slice(0,60));
const q=n.status?.queue||[]; console.log('queue',q.length,JSON.stringify(q.filter(x=>x.dub).slice(0,5)));
console.log('fails',JSON.stringify((n.status?.log||[]).filter(x=>x.failed||x.gaveUp).slice(-6)));
