import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,rm,stat} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {downloadVisionAudio} from '../vision-audio.mjs';

const payload=Uint8Array.from([1,2,3,4,5]);
async function check(mode, fn) {
 const dir=await mkdtemp(path.join(os.tmpdir(),'vision-test-')), output=path.join(dir,'audio');
 let n=0;
 const fetchImpl=async (url,opts)=>{
  n++;
  if(n===1) {
   assert.equal(JSON.parse(opts.body).context.client.clientName,'VISIONOS');
   return Response.json({playabilityStatus:{status:mode==='blocked'?'LOGIN_REQUIRED':'OK'},streamingData:{adaptiveFormats:[{mimeType:'audio/mp4; codecs="mp4a.40.2"',url:mode==='host'?'https://attacker.example/x':'https://abc.googlevideo.com/file',bitrate:128000,contentLength:String(mode==='oversize'?100:payload.length)}]}});
  }
  return new Response(mode==='short'?payload.subarray(0,2):payload,{status:200});
 };
 try {await fn(output,fetchImpl,()=>n);} finally {await rm(dir,{recursive:true,force:true});}
}
test('retrieves known byte count with isolated fake player and media',async()=>check('ok',async(output,fetchImpl,n)=>{
 assert.deepEqual(await downloadVisionAudio('testvideo01',output,{fetchImpl}),{bytes:5});
 assert.deepEqual(await readFile(output),Buffer.from(payload));assert.equal(n(),2);
}));
for(const mode of ['blocked','host','oversize','short']) test('rejects '+mode,async()=>check(mode,async(output,fetchImpl)=>{
 await assert.rejects(downloadVisionAudio('testvideo01',output,{fetchImpl,maxBytes:10}));
 await assert.rejects(stat(output),{code:'ENOENT'});
}));
test('rejects malformed video ID before network',async()=>assert.rejects(downloadVisionAudio('no','/unused',{fetchImpl:()=>{throw new Error('unexpected');}}),/Invalid video ID/));

test('reports player denial status without logging raw payload',async()=>check('blocked',async(output,fetchImpl)=>{
 await assert.rejects(downloadVisionAudio('testvideo01',output,{fetchImpl}),/Video unavailable: LOGIN_REQUIRED/);
}));
