const r=await fetch('https://www.hebcal.com/hebcal?v=1&cfg=json&s=on&i=on&leyning=on&F=on&o=on&nx=on&lg=he&start=2026-11-24&end=2026-12-06');
const j=await r.json(); console.log(r.status);
for(const x of (j.items||[])) console.log(x.date, x.category, x.title, '|', x.hebrew, '|', JSON.stringify(x.leyning||{}).slice(0,300));
const s=await fetch('https://searx.be/search?q=test&format=json').then(r=>r.status).catch(e=>String(e)); console.log('public searx',s);
