const M='https://main.176-97-205-41.sslip.io';
const want=process.env.WANT||'';
for(let i=0;i<90;i++){ const v=await fetch(M+'/version').then(r=>r.json()).catch(()=>({})); if(String(v.running||'').startsWith(want)){console.log('main',v.running,v.startedAt);break;} await new Promise(r=>setTimeout(r,20000)); }
for(const q of ['', 'מה פירש רש"י על הפסוק "בראשית ברא אלוקים את השמים ואת הארץ"? מה הוא אומר בדיוק?', 'מי חיבר את הספר חפץ חיים ומה עיקר תוכנו?']){
  const r=await fetch(M+'/health/models'+(q?'?q='+encodeURIComponent(q):''),{signal:AbortSignal.timeout(90000)}).then(r=>r.json()).catch(e=>({err:String(e)}));
  console.log('\n######## '+(q||'alive?'));
  for(const x of r.results||[r]) console.log((x.ok?'OK ':'-- ')+x.name+' | '+x.model+' | '+x.status+' | '+x.ms+'ms | '+String(x.answer||'').replace(/\s+/g,' '));
  await new Promise(r=>setTimeout(r,21000));
}
