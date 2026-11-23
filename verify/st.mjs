const tries=[
 ['search-wrapper', 'https://www.sefaria.org/api/search-wrapper', {query:'שתיקה',type:'text',field:'naive_lemmatizer',size:5,source_proj:true,slop:10,filters:['Mishnah/Seder Nezikin/Pirkei Avot'],filter_fields:['path'],aggs:[]}],
 ['search-wrapper nofilter', 'https://www.sefaria.org/api/search-wrapper', {query:'סייג לחכמה שתיקה',type:'text',field:'exact',size:3,source_proj:true}],
];
for(const [n,u,b] of tries){ const r=await fetch(u,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(b)}); const t=await r.text(); console.log('\n##',n,r.status,t.slice(0,1500)); }
for(const ref of ['Pirkei Avot 1:17','Rashi on Genesis 1:1','Mishneh Torah, Repentance 3:4']){ const r=await fetch('https://www.sefaria.org/api/v3/texts/'+encodeURIComponent(ref)+'?version=hebrew&return_format=text_only'); const j=await r.json(); console.log('\n##',ref,r.status,j.heRef,JSON.stringify(j.versions?.[0]?.text).slice(0,200)); }
const n=await fetch('https://www.sefaria.org/api/name/'+encodeURIComponent('פרקי אבות')).then(r=>r.json()); console.log('\nname',JSON.stringify(n).slice(0,500));
