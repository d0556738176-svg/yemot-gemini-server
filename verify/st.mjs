const h=await fetch('https://yedid-nefesh.com/',{headers:{'user-agent':'Mozilla/5.0 Chrome/130'}}).then(r=>r.text());
const vids=[...h.matchAll(/video-embedded#\]\((https:[^)\s]+)\)/g)].map(m=>m[1]);
console.log('videos',vids.length);
for(const v of vids.slice(0,2)){ for(const ref of ['', 'https://yedid-nefesh.chatfree.app/']) { const r=await fetch(v,{headers:{range:'bytes=0-200','user-agent':'Mozilla/5.0 Chrome/130',...(ref?{referer:ref}:{})}}); const b=await r.text(); console.log(r.status,r.headers.get('content-type'),r.headers.get('content-range'),b.slice(0,160).replace(/\s+/g,' ')); } }
const img=(h.match(/image-embedded#l?\]\((https:[^)\s]+)\)/)||[])[1]; if(img){ const r=await fetch(img); console.log('img',r.status,r.headers.get('content-type')); }
const p=await fetch('https://yedid-nefesh.chatfree.app/post/1413').then(r=>r.text()); const m=[...p.matchAll(/https:\/\/[^"'\s)]*objectstorage[^"'\s)]*/g)].map(x=>x[0]); console.log('post urls',[...new Set(m)].slice(0,6));
