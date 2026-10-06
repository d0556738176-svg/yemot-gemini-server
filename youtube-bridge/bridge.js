import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import process from 'node:process';
import WebSocket from 'ws';

const RENDER_BASE=(process.env.RENDER_BASE_URL||'').replace(/\/$/,'');
const BRIDGE_TOKEN=(process.env.BRIDGE_TOKEN||'').trim();
const POLL_MS=Number(process.env.POLL_MS||3000);
const DOWNLOAD_DIR=process.env.DOWNLOAD_DIR||path.join(os.homedir(),'Downloads','YemotYouTubeBridge');

if(!RENDER_BASE||!BRIDGE_TOKEN){
  console.error('Set RENDER_BASE_URL and BRIDGE_TOKEN before starting the bridge.');
  process.exit(1);
}
await fs.mkdir(DOWNLOAD_DIR,{recursive:true});

async function api(pathname,options={}){
  const r=await fetch(RENDER_BASE+pathname,{...options,headers:{'Authorization':'Bearer '+BRIDGE_TOKEN,...(options.headers||{})}});
  const text=await r.text();
  let data={}; try{data=JSON.parse(text)}catch{}
  if(!r.ok) throw new Error(data.error||text||('HTTP '+r.status));
  return data;
}
async function getJob(){
  return api('/api/youtube-bridge/jobs/next',{method:'POST'});
}
function downloadWithNF(url,destinationPath){
  return new Promise((resolve,reject)=>{
    const ws=new WebSocket('ws://127.0.0.1:9595/ws');
    let settled=false;
    const finish=(err,value)=>{if(settled)return;settled=true;try{ws.close()}catch{};err?reject(err):resolve(value)};
    ws.on('open',()=>{
      ws.send(JSON.stringify({
        type:'download',
        url,
        formatId:'generic_audio',
        destinationPath
      }));
    });
    ws.on('message',async raw=>{
      try{
        const m=JSON.parse(raw.toString());
        if(m.type==='success'&&m.path) finish(null,m.path);
        else if(m.type==='error') finish(new Error(m.error||'NFmp3Downloader error'));
      }catch(e){finish(e)}
    });
    ws.on('error',e=>finish(new Error('NFmp3Downloader is not running or port 9595 is unavailable: '+e.message)));
    setTimeout(()=>finish(new Error('NFmp3Downloader download timeout')),10*60*1000);
  });
}
async function uploadJob(job,filePath){
  const stat=await fs.stat(filePath);
  if(stat.size>120*1024*1024) throw new Error('Downloaded audio is too large');
  const buf=await fs.readFile(filePath);
  const r=await fetch(RENDER_BASE+'/api/youtube-bridge/jobs/'+encodeURIComponent(job.id)+'/file',{
    method:'POST',
    headers:{'Authorization':'Bearer '+BRIDGE_TOKEN,'Content-Type':'audio/mpeg','X-Bridge-File-Name':path.basename(filePath)},
    body:buf
  });
  const text=await r.text(); let data={}; try{data=JSON.parse(text)}catch{}
  if(!r.ok) throw new Error(data.error||text||('Upload HTTP '+r.status));
  return data;
}
async function loop(){
  while(true){
    try{
      const data=await getJob();
      if(!data.job){await new Promise(r=>setTimeout(r,POLL_MS));continue}
      const job=data.job;
      const url='https://www.youtube.com/watch?v='+encodeURIComponent(job.videoId);
      const file=await downloadWithNF(url,DOWNLOAD_DIR);
      await uploadJob(job,file);
      await fs.rm(file,{force:true}).catch(()=>{});
    }catch(e){
      console.error(new Date().toISOString(),e.message);
      await new Promise(r=>setTimeout(r,5000));
    }
  }
}
console.log('Yemot YouTube NF bridge running.');
console.log('Render:',RENDER_BASE);
console.log('Download directory:',DOWNLOAD_DIR);
await loop();
