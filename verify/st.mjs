const r=await fetch('https://yedid-nefesh.com/',{headers:{'user-agent':'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/130 Safari/537.36','accept-language':'he'}});
const h=await r.text();
console.log('status',r.status,'len',h.length);
const urls=[...new Set(h.match(/https?:\/\/[^"'\s<>\\]+/g)||[])];
console.log('urls',urls.length); for(const u of urls.slice(0,60)) console.log(u.slice(0,200));
const vid=[...h.matchAll(/(?:mp4|m3u8|video|objectstorage)[^"'<>]{0,120}/gi)].slice(0,20).map(m=>m[0]); console.log('video-ish',JSON.stringify(vid,null,1).slice(0,3000));
const i=h.indexOf('__NEXT_DATA__'); console.log('next',i, i>0?h.slice(i,i+1500):'');
const apis=[...new Set(h.match(/\/api\/[A-Za-z0-9_\/\-]+/g)||[])]; console.log('apis',apis.slice(0,40));
for (const p of ['/api/channel','/api/posts','/api/messages','/robots.txt','/sitemap.xml']) { const x=await fetch('https://yedid-nefesh.com'+p).then(async r=>r.status+' '+(await r.text()).slice(0,300)).catch(e=>'ERR '+e); console.log(p,x.replace(/\s+/g,' ')); }
