const M='https://main.176-97-205-41.sslip.io', E='https://ext2.176-97-205-41.sslip.io';
const j=async u=>{try{const r=await fetch(u,{signal:AbortSignal.timeout(30000)});return {s:r.status,b:await r.text()};}catch(e){return {s:0,b:String(e)}}};
// wait for main to run the new commit
for(let i=0;i<20;i++){ const h=await j(M+'/health'); if(/4d642ad/.test(h.b)) {console.log('main on 4d642ad');break;} if(i==19) console.log('main health:',h.b.slice(0,300)); await new Promise(x=>setTimeout(x,20000)); }
const s=await j(M+'/health/songs'); console.log('songs',s.s,s.b.slice(0,1500));
const n=await j(E+'/news-status'); let d={}; try{d=JSON.parse(n.b)}catch{}
console.log('news',n.s, JSON.stringify(d.topics||d).slice(0,6000));
