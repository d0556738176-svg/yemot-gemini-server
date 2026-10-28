import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import vm from 'node:vm';
import {spawn,execFile} from 'node:child_process';
import {promisify} from 'node:util';
import ffmpegPath from 'ffmpeg-static';
const exec=promisify(execFile);
async function productionChunker(){
  const source=await fs.readFile(new URL('./youtube-authorized-playback.js',import.meta.url),'utf8');
  const run=source.slice(source.indexOf('function runFfmpeg('),source.indexOf('async function makeChunks('));
  const chunks=source.slice(source.indexOf('async function makeChunks('),source.indexOf('async function uploadToYemot('));
  const context=vm.createContext({fs,path,spawn,ffmpegPath,FFMPEG_TIMEOUT_MS:900000,AbortController,AbortSignal,setTimeout,clearTimeout,console:{info(){}}});
  return vm.runInContext(run+chunks+';makeChunks',context);
}
function pcmDuration(b){
  assert.equal(b.subarray(0,4).toString(),'RIFF');
  assert.equal(b.readUInt32LE(4)+8,b.length,'WAV must be closed before upload');
  for(let i=12;i+8<=b.length;){
    const size=b.readUInt32LE(i+4);
    if(b.subarray(i,i+4).toString()==='data')return size/16000;
    i+=8+size+(size%2);
  }
  assert.fail('missing PCM data');
}
test('65 minutes converts to complete ordered finalized WAVs and uploads before conversion ends',{timeout:180000},async()=>{
  const temp=await fs.mkdtemp(path.join(os.tmpdir(),'hour-audio-test-'));
  try {
    const source=path.join(temp,'long.mp3');
    await exec(ffmpegPath,['-hide_banner','-loglevel','error','-y','-f','lavfi','-i','sine=frequency=440:sample_rate=22050','-t','3905','-c:a','libmp3lame','-b:a','96k',source],{timeout:120000});
    const makeChunks=await productionChunker();
    let seconds=0,overlap=false;const indices=[];
    const files=await makeChunks(source,path.join(temp,'chunks'),undefined,async(file,index,info)=>{
      indices.push(index);seconds+=pcmDuration(await fs.readFile(file));overlap ||= info.converting;
    });
    assert.equal(files.length,33);assert.equal(indices.join(','),Array.from({length:33},(_,i)=>i).join(','));
    assert.ok(Math.abs(seconds-3905)<1,'complete duration preserved');
    assert.ok(overlap,'closed chunks must become available before the whole conversion ends');
  } finally {await fs.rm(temp,{recursive:true,force:true});}
});
test('upload failure aborts conversion and never returns a partial ready list',{timeout:30000},async()=>{
 const makeChunks=await productionChunker(),temp=await fs.mkdtemp(path.join(os.tmpdir(),'chunk-failure-'));
 try{
  const source=path.join(temp,'source.wav');
  await exec(ffmpegPath,['-hide_banner','-loglevel','error','-y','-f','lavfi','-i','anullsrc=r=8000:cl=mono','-t','245',source]);
  await assert.rejects(makeChunks(source,path.join(temp,'chunks'),undefined,async()=>{throw Error('upload failed');}),/upload failed/);
 }finally{await fs.rm(temp,{recursive:true,force:true});}
});
test('already aborted conversion cannot return ready chunks',async()=>{
 const makeChunks=await productionChunker(),temp=await fs.mkdtemp(path.join(os.tmpdir(),'chunk-abort-'));
 try{const controller=new AbortController();controller.abort();await assert.rejects(makeChunks('/missing',temp,controller.signal),e=>e.name==='AbortError');}
 finally{await fs.rm(temp,{recursive:true,force:true});}
});
