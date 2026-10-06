import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import ffmpegPath from 'ffmpeg-static';

const YEMOT_API_BASE='https://www.call2all.co.il/ym/api';
const MAX_BYTES=120*1024*1024;

function yemotToken(){
  const token=String(process.env.YEMOT_API_KEY||'').trim();
  if(!token) throw new Error('YEMOT_API_KEY is missing');
  return token;
}
function runFfmpeg(args){
  return new Promise((resolve,reject)=>{
    if(!ffmpegPath) return reject(new Error('ffmpeg-static unavailable'));
    const p=spawn(ffmpegPath,args,{stdio:['ignore','ignore','pipe']});
    let err='';
    p.stderr.on('data',b=>{err+=b.toString();if(err.length>5000)err=err.slice(-5000)});
    p.on('error',reject);
    p.on('close',c=>c===0?resolve():reject(new Error('ffmpeg failed '+c+': '+err.slice(-1800))));
  });
}
async function upload(file,remote){
  const buf=await fs.readFile(file);
  const u=new URL(YEMOT_API_BASE+'/UploadFile');
  u.searchParams.set('token',yemotToken());
  u.searchParams.set('path',remote);
  u.searchParams.set('convertAudio','0');
  u.searchParams.set('autoNumbering','false');
  const form=new FormData();
  form.append('file',new Blob([buf],{type:'audio/wav'}),path.basename(file));
  const r=await fetch(u,{method:'POST',body:form});
  const body=await r.text();
  if(!r.ok) throw new Error('Yemot UploadFile HTTP '+r.status);
  let j; try{j=JSON.parse(body)}catch{throw new Error('Invalid Yemot UploadFile JSON')};
  if(j.responseStatus && j.responseStatus!=='OK') throw new Error('Yemot upload failed: '+(j.message||j.responseStatus));
}
async function verify(remote){
  const u=new URL(YEMOT_API_BASE+'/GetFile');
  u.searchParams.set('token',yemotToken());
  u.searchParams.set('what',remote);
  const r=await fetch(u,{signal:AbortSignal.timeout(10000)});
  const body=await r.text();
  let j=null; try{j=JSON.parse(body)}catch{}
  if(!r.ok || j?.responseStatus!=='OK') throw new Error('Yemot file verification failed');
  return j;
}
export async function uploadBridgeAudioToYemot(videoId,audioBuffer){
  if(!Buffer.isBuffer(audioBuffer)) audioBuffer=Buffer.from(audioBuffer);
  if(!audioBuffer.length || audioBuffer.length>MAX_BYTES) throw new Error('Bridge audio size is invalid');
  const id=String(videoId||'').trim();
  if(!/^[A-Za-z0-9_-]{6,20}$/.test(id)) throw new Error('Invalid video id');
  const temp=await fs.mkdtemp(path.join(os.tmpdir(),'youtube-bridge-'));
  try{
    const src=path.join(temp,id+'.mp3');
    const wavDir=path.join(temp,'wav');
    await fs.writeFile(src,audioBuffer);
    await fs.mkdir(wavDir,{recursive:true});
    const pattern=path.join(wavDir,'chunk-%03d.wav');
    await runFfmpeg(['-hide_banner','-loglevel','error','-y','-i',src,'-vn','-ar','8000','-ac','1','-c:a','pcm_s16le','-f','segment','-segment_time','120','-reset_timestamps','1',pattern]);
    const names=(await fs.readdir(wavDir)).filter(x=>/^chunk-\d{3}\.wav$/.test(x)).sort();
    if(!names.length) throw new Error('No WAV chunks produced');
    const playbackPaths=[];
    for(let i=0;i<names.length;i++){
      const remote='ivr2:/2/youtube-bridge/'+id+'-'+String(i+1).padStart(3,'0')+'.wav';
      await upload(path.join(wavDir,names[i]),remote);
      await verify(remote);
      playbackPaths.push('/2/youtube-bridge/'+id+'-'+String(i+1).padStart(3,'0'));
    }
    return {playbackPaths,chunkCount:playbackPaths.length};
  }finally{await fs.rm(temp,{recursive:true,force:true}).catch(()=>{})}
}
