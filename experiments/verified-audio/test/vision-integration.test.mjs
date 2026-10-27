import {test} from 'node:test';
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {existsSync} from 'node:fs';
import {mkdtemp,readFile,rm} from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import ffmpegPath from 'ffmpeg-static';
import {downloadAuthorizedAudioToYemot} from '../../../youtube-authorized-playback.js';
test('vision client to Yemot path with simulated services',{skip: !ffmpegPath || !existsSync(ffmpegPath)},async()=>{
 const dir=await mkdtemp(path.join(os.tmpdir(),'vision-flow-')), source=path.join(dir,'tone.m4a');
 const savedFetch=globalThis.fetch, previous={...process.env}; let uploaded=0, exists=false;
 try {
  execFileSync(ffmpegPath,['-v','error','-f','lavfi','-i','sine=frequency=440:duration=2','-c:a','aac','-y',source]);
  const data=await readFile(source);
  process.env.YOUTUBE_VISIONOS_EXPERIMENT='true'; process.env.YEMOT_API_KEY='fake-token';
  globalThis.fetch=async(input,options={})=>{
   const u=new URL(input);
   if(u.hostname==='www.youtube.com') return Response.json({playabilityStatus:{status:'OK'},streamingData:{adaptiveFormats:[{mimeType:'audio/mp4',url:'https://mock.googlevideo.com/a',contentLength:String(data.length),bitrate:128000}]}});
   if(u.hostname==='mock.googlevideo.com') return new Response(data);
   if(u.hostname==='www.call2all.co.il' && u.pathname.endsWith('/GetFile')) return Response.json({responseStatus:exists?'OK':'ERROR'});
   if(u.hostname==='www.call2all.co.il' && u.pathname.endsWith('/UploadFile')) {
    const bytes=Buffer.from(await options.body.get('file').arrayBuffer());
    assert.equal(bytes.subarray(0,4).toString(),'RIFF');
    assert.equal(bytes.readUInt32LE(24),8000);uploaded++;exists=true;
    return Response.json({responseStatus:'OK'});
   }
   throw new Error('Unexpected external request');
  };
  const result=await downloadAuthorizedAudioToYemot('testvideo01');
  assert.equal(result.chunkCount,1);assert.equal(uploaded,1);
 } finally {globalThis.fetch=savedFetch;process.env=previous;await rm(dir,{recursive:true,force:true});}
});
