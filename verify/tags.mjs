const BASE='https://ext2.176-97-205-41.sslip.io', WANT=process.env.WANT||'';
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
for(let i=0;i<100;i++){const d=await fetch(BASE+'/branch2-diag').then(r=>r.json()).catch(()=>({}));if(String(d.commit||'').startsWith(WANT))break;await sleep(20000);}
for(const id of (process.env.Q||'').split(',')){
  const r=await fetch(BASE+'/branch2-saved?id='+id,{signal:AbortSignal.timeout(300000)}).then(r=>r.json()).catch(e=>({err:String(e)}));
  console.log('\n#### '+id); for(const c of r.audioCopy||[]) console.log(JSON.stringify({path:c.path,size:c.size,picture:c.probe?.picture,pictureSize:c.probe?.pictureSize,audio:c.probe?.audio,tags:c.probe?.tags},null,1));
  for(const f of r.video?.files||[]) console.log('VIDEO',JSON.stringify({path:f.path,picture:f.probe?.picture,pictureSize:f.probe?.pictureSize,tags:f.probe?.tags},null,1));
}
