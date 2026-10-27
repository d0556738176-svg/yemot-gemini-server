import {test} from 'node:test';
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {existsSync} from 'node:fs';
import {mkdtemp,readFile,rm} from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import ffmpegPath from 'ffmpeg-static';
import {downloadAuthorizedAudioToYemot} from '../youtube-authorized-playback.js';

test('branch 2 uses vision audio and sends WAV to simulated Yemot', {skip:!ffmpegPath||!existsSync(ffmpegPath)}, async()=>{
 const dir=await mkdtemp(path.join(os.tmpdir(),'stage-vision-')); const saved=globalThis.fetch;const env={...process.env};let count=0,uploaded=false;
 try {
  let name=path.join(dir,'tone.m4a');execFileSync(ffmpegPath,['-v','error','-f','lavfi','-i','sine=frequency=500:duration=2','-c:a','aac','-y',name]);
  let audio=await readFile(name);process.env.YEMOT_API_KEY='fake-key';delete process.env.YOUTUBE_VISIONOS_EXPERIMENT;
  globalThis.fetch=async(input,options={})=>{
   const url=new URL(input);
   if(url.hostname==='www.youtube.com') return Response.json({playabilityStatus:{status:'OK'},streamingData:{adaptiveFormats:[{mimeType:'audio/mp4',url:'https://mock.googlevideo.com/a',contentLength:String(audio.length),bitrate:128000}]}});
   if(url.hostname==='mock.googlevideo.com')return new Response(audio);
   if(url.hostname==='www.call2all.co.il'&&url.pathname.endsWith('/GetFile'))return Response.json({responseStatus:uploaded?'OK':'ERROR'});
   if(url.hostname==='www.call2all.co.il'&&url.pathname.endsWith('/UploadFile')){
    let wav=Buffer.from(await options.body.get('file').arrayBuffer());assert.equal(wav.subarray(0,4).toString(),'RIFF');assert.equal(wav.readUInt32LE(24),8000);count++;uploaded=true;return Response.json({responseStatus:'OK'});
   }
   throw new Error('Unexpected request');
  };
  let result=await downloadAuthorizedAudioToYemot('testvideo01');
  assert.equal(result.chunkCount,1);assert.equal(count,1);
 } finally {globalThis.fetch=saved;process.env=env;await rm(dir,{recursive:true,force:true});}
});

test('vision failure reaches existing fallback without uploading',async()=>{
 const saved=globalThis.fetch;const env={...process.env};let uploads=0;
 try {
  delete process.env.YOUTUBE_VISIONOS_EXPERIMENT;delete process.env.SUPABASE_URL;delete process.env.SUPABASE_KEY;delete process.env.AUTHORIZED_AUDIO_SOURCES_JSON;
  globalThis.fetch=async input=>{let u=new URL(input);if(u.hostname==='www.youtube.com')return Response.json({playabilityStatus:{status:'LOGIN_REQUIRED'}});if(u.hostname==='www.call2all.co.il')uploads++;throw new Error('unexpected request');};
  await assert.rejects(downloadAuthorizedAudioToYemot('testvideo02'),/No authorized audio source/);assert.equal(uploads,0);
 } finally {globalThis.fetch=saved;process.env=env;}
});
