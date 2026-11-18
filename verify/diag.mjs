const BASE='https://ext2.176-97-205-41.sslip.io', WANT=process.env.WANT||'';
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
for(let i=0;i<140;i++){
  const d=await fetch(BASE+'/branch2-diag').then(r=>r.json()).catch(e=>({err:String(e)}));
  const t=d.engineTest||{};
  console.log(new Date().toISOString(),'commit',d.commit,'test',t.status,'engines',JSON.stringify(t.engines),'sites',(t.sites||[]).length);
  if(t.status==='done'&&String(t.startedAt||'')>WANT){ console.log(JSON.stringify(t,null,1)); console.log('webEvents',JSON.stringify(d.webEvents,null,1)); process.exit(0);}
  await sleep(20000);
}
process.exit(1);
