const h=await fetch('https://yedid-nefesh.com/',{headers:{'user-agent':'Mozilla/5.0 Chrome/130','accept-language':'he'}}).then(r=>r.text());
const i=h.indexOf('/post/1413'); console.log(h.slice(i-200,i+2600));
console.log('-----'); const j=h.indexOf('video-embedded'); console.log(h.slice(j-1500,j+400));
const p=await fetch('https://yedid-nefesh.chatfree.app/post/1413',{headers:{'user-agent':'Mozilla/5.0 Chrome/130'}}).then(async r=>r.status+' '+(await r.text())).catch(e=>'ERR '+e);
console.log('----- post page', p.length); const k=p.indexOf('video-embedded'); console.log(p.slice(0,200)); console.log(k, p.slice(Math.max(0,k-1200),k+300));
const v=(h.match(/video-embedded#\]\((https:[^)]+)\)/)||[])[1]; if(v){ const r=await fetch(v,{method:'HEAD'}); console.log('video head',r.status,r.headers.get('content-type'),r.headers.get('content-length')); }
