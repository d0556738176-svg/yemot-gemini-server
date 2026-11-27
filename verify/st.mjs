const B='https://lobbytube.co.il';
const UA={'user-agent':'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/130 Safari/537.36','accept-language':'he'};
const cat=encodeURIComponent('מוזיקה');
const r=await fetch(B+'/categories/'+cat,{headers:UA}); const h=await r.text();
console.log('status',r.status,'len',h.length,'watch',(h.match(/\/watch\/[A-Za-z0-9_-]{11}/g)||[]).length,'channels',(h.match(/\/channels\/UC[A-Za-z0-9_-]{22}/g)||[]).length, 'nextdata',h.includes('__NEXT_DATA__'),'rsc',h.includes('self.__next_f'));
const scripts=[...new Set([...h.matchAll(/src="(\/_next\/static\/[^"]+\.js)"/g)].map(m=>m[1]))];
console.log('scripts',scripts.length);
const apis=new Set();
for(const s of scripts){ const t=await (await fetch(B+s,{headers:UA})).text(); for(const m of t.matchAll(/["'`](\/api\/[A-Za-z0-9_\/\-\.\?=&${}]+)["'`]/g)) apis.add(m[1]); for(const m of t.matchAll(/https?:\/\/[a-z0-9\.\-]+\.(?:co\.il|com|io|app|dev)\/[A-Za-z0-9_\/\-]*/g)) if(!/youtube|google|gstatic|w3|schema|react|nextjs|vercel/.test(m[0])) apis.add(m[0]); }
console.log('apis',[...apis].slice(0,120).join('\n'));
// sample RSC chunk around first watch link
const i=h.indexOf('/watch/'); console.log('around', h.slice(Math.max(0,i-800),i+400).replace(/\s+/g,' '));
