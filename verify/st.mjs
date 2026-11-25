const M='https://main.176-97-205-41.sslip.io', E='https://ext2.176-97-205-41.sslip.io';
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
for(let i=0;i<40;i++){ const v=await fetch(M+'/version').then(r=>r.json()).catch(()=>({})); if(String(v.running||'').startsWith('3577623')){console.log('main',v.running,v.startedAt);break;} if(i==39) console.log('version',JSON.stringify(v)); await sleep(20000); }
const n=await fetch(E+'/news-status').then(r=>r.json()).catch(e=>({err:String(e)}));
const st=n.status||{};
console.log('keys',Object.keys(n).join(','), '| status keys', Object.keys(st).join(','));
const ch=st.channels||n.channels||{};
console.log('channels', JSON.stringify(ch).slice(0,5000));
for(const [t,v] of Object.entries(n.topics||{})) console.log('topic',t,v.title,'files',v.files, (v.newest||[]).slice(0,4).map(x=>x.ch+': '+x.title.slice(0,40)).join(' | '));
console.log('settings', JSON.stringify(n.settings||n.ini||'').slice(0,1500));
