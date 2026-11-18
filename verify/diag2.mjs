const BASE='https://ext2.176-97-205-41.sslip.io', AFTER=process.env.WANT||'';
const Q=process.env.Q||'';
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
let triggered=false;
for(let i=0;i<140;i++){
  const d=await fetch(BASE+'/branch2-diag').then(r=>r.json()).catch(e=>({err:String(e)}));
  const t=d.engineTest||{};
  console.log(new Date().toISOString(),'commit',d.commit,'started',d.startedAt,'test',t.status,t.startedAt,'sites',(t.sites||[]).length);
  if(String(d.startedAt||'')>AFTER && t.status!=='running' && !triggered){ const r=await fetch(BASE+'/branch2-engine-test?n=3&q='+encodeURIComponent(Q)).then(r=>r.json()).catch(e=>({err:String(e)})); console.log('trigger',JSON.stringify(r)); if(r.ok) triggered=true; }
  else if(triggered && t.status==='done'){ console.log(JSON.stringify(t,null,1)); console.log('browserEvents',JSON.stringify(d.browserEvents,null,1)); console.log('webEvents',JSON.stringify(d.webEvents.slice(-20),null,1)); process.exit(0);}
  await sleep(20000);
}
process.exit(1);
