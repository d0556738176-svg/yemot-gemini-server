import {test} from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {mkdtemp, readFile, rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import {downloadVerified} from '../verified-download.mjs';

test('generated sound: download, convert and simulated upload', async()=>{
  const dir=await mkdtemp(path.join(os.tmpdir(),'audio-chain-'));
  const source=path.join(dir,'source.m4a'), copied=path.join(dir,'copy.m4a'), wave=path.join(dir,'audio.wav');
  let uploaded=null;
  execFileSync('ffmpeg',['-v','error','-f','lavfi','-i','sine=frequency=440:duration=2','-c:a','aac','-y',source]);
  const original=await readFile(source);
  const server=http.createServer((req,res)=>{
    if(req.method==='POST' && req.url==='/upload') {
      const chunks=[]; req.on('data',c=>chunks.push(c)); req.on('end',()=>{uploaded=Buffer.concat(chunks);res.writeHead(200,{'Content-Type':'application/json'}).end(JSON.stringify({responseStatus:'OK'}));}); return;
    }
    const m=/^bytes=(\d+)-(\d+)$/.exec(req.headers.range||'');
    if(!m) return res.writeHead(400).end();
    const start=+m[1], end=Math.min(+m[2],original.length-1);
    res.writeHead(206,{'Content-Range':`bytes ${start}-${end}/${original.length}`,ETag:'"sound-v1"'}).end(original.subarray(start,end+1));
  });
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  try {
    const base=`http://127.0.0.1:${server.address().port}`;
    await downloadVerified(base+'/source',copied,{chunkBytes:4096});
    assert.deepEqual(await readFile(copied),original);
    execFileSync('ffmpeg',['-v','error','-xerror','-i',copied,'-ar','8000','-ac','1','-c:a','pcm_s16le','-y',wave]);
    const probe=JSON.parse(execFileSync('ffprobe',['-v','error','-show_entries','stream=codec_name,sample_rate,channels','-of','json',wave],{encoding:'utf8'}));
    assert.deepEqual(probe.streams[0],{codec_name:'pcm_s16le',sample_rate:'8000',channels:1});
    const wav=await readFile(wave);
    const res=await fetch(base+'/upload',{method:'POST',body:wav});
    assert.equal((await res.json()).responseStatus,'OK');
    assert.deepEqual(uploaded,wav);
  } finally { await new Promise(resolve=>server.close(resolve)); await rm(dir,{recursive:true,force:true}); }
});
