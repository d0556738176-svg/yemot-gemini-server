import { test } from 'node:test';
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {mkdtemp,readFile,rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {downloadAuthorizedAudioToYemot} from '../../../youtube-authorized-playback.js';
import ffmpegPath from 'ffmpeg-static';

test('actual branch 2 playback pipeline with simulated source and Yemot API',async()=>{
 const dir=await mkdtemp(path.join(os.tmpdir(),'ivr-int-'));
 try {
  const audio=path.join(dir,'tone.m4a');
  execFileSync(ffmpegPath,['-v','error','-f','lavfi','-i','sine=frequency=440:duration=2','-c:a','aac','-y',audio]);
  const bytes=await readFile(audio);
  const oldFetch=globalThis.fetch;
  const saved={...process.env};
  let uploads=0, verified=false;
  try {
   process.env.YOUTUBE_VERIFIED_RANGES='true';
   process.env.AUTHORIZED_AUDIO_HOSTS='audio.example.test';
   process.env.AUTHORIZED_AUDIO_SOURCES_JSON=JSON.stringify({testvideo01:'https://audio.example.test/tone.m4a'});
   process.env.YEMOT_API_KEY='test-token';
   delete process.env.SUPABASE_URL; delete process.env.SUPABASE_KEY;
   globalThis.fetch=async (input,opts={})=>{
    const u=new URL(input);
    if (u.hostname==='audio.example.test') {
      const m=/^bytes=(\d+)-(\d+)$/.exec(opts.headers.Range);
      const a=+m[1],b=Math.min(+m[2],bytes.length-1);
      return new Response(bytes.subarray(a,b+1),{status:206,headers:{'content-range':`bytes ${a}-${b}/${bytes.length}`,etag:'"audio-1"'}});
    }
    if(u.hostname==='www.call2all.co.il' && u.pathname.endsWith('/GetFile')) return Response.json({responseStatus:verified?'OK':'ERROR'});
    if(u.hostname==='www.call2all.co.il' && u.pathname.endsWith('/UploadFile')) {
      assert.equal(opts.method,'POST');
      const part=opts.body.get('file'); const data=Buffer.from(await part.arrayBuffer());
      assert.equal(data.subarray(0,4).toString(),'RIFF');
      assert.equal(data.readUInt32LE(24),8000); assert.equal(data.readUInt16LE(22),1);
      uploads++; verified=true; return Response.json({responseStatus:'OK'});
    }
    throw new Error('Unexpected external request');
   };
   const result=await downloadAuthorizedAudioToYemot('testvideo01');
   assert.deepEqual(result,{playbackPaths:['/2/youtube-authorized/testvideo01-001'],chunkCount:1});
   assert.equal(uploads,1); assert.equal(verified,true);
  } finally {globalThis.fetch=oldFetch; process.env=saved;}
 } finally {await rm(dir,{recursive:true,force:true});}
});
