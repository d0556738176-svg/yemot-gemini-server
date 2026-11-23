const r=await fetch('https://www.hebcal.com/hebcal?v=1&cfg=json&maj=on&min=on&mod=on&nx=on&ss=off&mf=on&c=off&i=on&lg=he&start=2026-11-24&end=2027-11-30');
const j=await r.json(); console.log(r.status, (j.items||[]).length);
for(const x of (j.items||[]).slice(0,40)) console.log(x.date, x.category, x.subcat||'', x.title, '|', x.hebrew);
