const E='https://ext2.176-97-205-41.sslip.io';
const n=await fetch(E+'/news-status').then(r=>r.json()).catch(e=>({err:String(e)}));
const ch=n.status?.channels||{};
for(const [k,v] of Object.entries(ch)) if(v.topic==='5' && !(v.feedTitles&&Object.keys(v.feedTitles).length)) console.log('MISSING',k,v.error||'');
for(const [k,v] of Object.entries(ch)) if(['derech','magal','updates','onedge','taub','kolmashekore','shabak','privatenews','pikud','gpo','crux','bluepaw','keshet12','ch24'].includes(k)) console.log(k, JSON.stringify(Object.values(v.feedTitles||{})));
console.log('seen',JSON.stringify(n.searchSeen||{}).slice(0,5000));
for(const [t,v] of Object.entries(n.topics||{})) console.log('topic',t,'files',v.files);
