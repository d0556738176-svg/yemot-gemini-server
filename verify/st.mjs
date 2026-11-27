const E='https://ext2.176-97-205-41.sslip.io';
const n=await fetch(E+'/news-status').then(r=>r.json()).catch(e=>({err:String(e)}));
const ch=n.status?.channels||{};
for(const [k,v] of Object.entries(ch)) if(v.topic==='1'||v.topic==='5') console.log(v.topic,k, JSON.stringify(Object.values(v.feedTitles||{})), v.error||'', (v.latest||'').slice(0,40));
for(const [t,v] of Object.entries(n.topics||{})) console.log('topic',t,v.title,'files',v.files,(v.newest||[]).slice(0,2).map(x=>x.file).join(','));
console.log('settings', JSON.stringify(n.settings||{}).slice(0,1200));
console.log('log', JSON.stringify((n.status?.log||[]).filter(x=>x.movedToMainPart!==undefined||x.droppedChannelFiles||x.failed).slice(-8)));
