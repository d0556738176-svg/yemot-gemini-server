const E='https://ext2.176-97-205-41.sslip.io';
const n=await fetch(E+'/news-status').then(r=>r.json()).catch(e=>({err:String(e)}));
const T=n.topics||{}; for(const t of ['1','5','2','T2']) { const v=T[t]||{}; console.log(t,v.title,'files',v.files,JSON.stringify((v.newest||[]).slice(0,3).map(x=>x.file+' '+(x.ch||'')))); }
console.log('settings', JSON.stringify(n.settings?.['/11/2']||null), JSON.stringify(n.settings?.['/11/2/2']||null));
console.log('log', JSON.stringify((n.status?.log||[]).filter(x=>x.movedToMainPart!==undefined||x.channelFilesMoved).slice(-4)));
