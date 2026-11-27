const E='https://ext2.176-97-205-41.sslip.io';
const n=await fetch(E+'/news-status').then(r=>r.json()).catch(e=>({err:String(e)}));
const ch=n.status?.channels||{};
for(const [k,v] of Object.entries(ch)) if(v.topic==='1') console.log(k,'|',v.title,'|',JSON.stringify(Object.values(v.feedTitles||{})),'|',(v.latest||'').slice(0,70));
const idx=(n.topics?.['1']?.newest||[]); const by={}; for(const x of idx) (by[x.ch]=by[x.ch]||[]).push(x.title?.slice(0,50)); for(const [k,v] of Object.entries(by)) console.log('FILES',k,JSON.stringify(v.slice(0,4)));
