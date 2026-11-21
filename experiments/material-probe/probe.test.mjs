import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {classify,uploadAndVerify} from './probe.mjs';

test('classifies real downloader failures without retaining sensitive output',()=>{
  assert.equal(classify("Sign in to confirm you're not a bot"),'YOUTUBE_BOT_CHALLENGE');
  assert.equal(classify('HTTP 429 Too Many Requests'),'RATE_LIMITED');
  assert.equal(classify('certificate verify failed'),'TLS_CERTIFICATE_ERROR');
});

test('upload success requires byte-identical readback, not merely HTTP 200',async()=>{
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'probe-test-'));
  const file=path.join(dir,'001.wav'),data=Buffer.from('RIFF-example-audio');
  await fs.writeFile(file,data);
  try {
    let calls=0;
    const fetchImpl=async(url,opts)=>{
      calls++;
      assert.equal(opts.method,'POST');
      assert.equal(new URL(url).search,'');
      if(calls===1) return Response.json({responseStatus:'OK'});
      return new Response(data);
    };
    const r=await uploadAndVerify(file,'ivr2:/2/material-selftest/test-run/001.wav',{token:'test-only',fetchImpl});
    assert.equal(calls,2);assert.equal(r.verifiedBytes,data.length);
    let n=0;
    await assert.rejects(uploadAndVerify(file,'ivr2:/2/material-selftest/test-run/001.wav',{token:'test-only',fetchImpl:async()=>++n===1?Response.json({responseStatus:'OK'}):new Response('wrong file')}),/READBACK_MISMATCH/);
    await assert.rejects(uploadAndVerify(file,'ivr2:/2/material-selftest/test-run/001.wav',{token:'test-only',fetchImpl:async()=>Response.json({})}),/UPLOAD_REJECTED/);
    await assert.rejects(uploadAndVerify(file,'ivr2:/2/ext.ini',{token:'test-only'}),/UNSAFE_TEST_PATH/);
  } finally {await fs.rm(dir,{recursive:true,force:true})}
});
