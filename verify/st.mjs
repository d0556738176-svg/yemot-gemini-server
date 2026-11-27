const E='https://ext2.176-97-205-41.sslip.io';
const n=await fetch(E+'/news-status').then(r=>r.json()).catch(e=>({err:String(e)}));
const c=n.status?.channels?.onedge||{}; console.log('onedge',JSON.stringify({feed:c.feedTitles,latest:c.latest,error:c.error}));
console.log('queued',JSON.stringify((n.status?.queue||[]).filter(x=>x.ch==='onedge')));
console.log('published',JSON.stringify((n.topics?.['5']?.newest||[]).filter(x=>x.ch==='onedge'||/On Edge/.test(x.ch||''))));
console.log('log',JSON.stringify((n.status?.log||[]).filter(x=>x.ch==='onedge').slice(-5)));
