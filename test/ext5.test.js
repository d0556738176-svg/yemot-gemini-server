import {test} from 'node:test';
import assert from 'node:assert/strict';
import {publishToExt5} from '../branch2-ext5.js';
function fixture() {
 let state = null; const uploads=[];
 return {uploads, readJson:async()=>state, writeJson:async(_,s)=>{state=s;}, list:async()=>({responseStatus:'OK',files:[{name:'004.wav'}]}), upload:async(_,p)=>uploads.push(p)};
}
test('concurrent publications preserve existing audio and deduplicate repeated ids',async()=>{
 const io=fixture(); await Promise.all([publishToExt5('a','local','A',io),publishToExt5('b','local','B',io),publishToExt5('a','local','A',io)]);
 assert.deepEqual(io.uploads,['ivr2:/5/005.wav','ivr2:/5/006.wav']);
});
test('failed upload is not indexed as complete and retry reserves a fresh filename',async()=>{
 const io=fixture(); const upload=io.upload;io.upload=async()=>{throw new Error('network');};
 await assert.rejects(publishToExt5('a','local','A',io));io.upload=upload;
 const out=await publishToExt5('a','local','A',io);assert.equal(out.file,'006');
});
test('listing failure never writes or uploads',async()=>{
 const io=fixture();io.list=async()=>({responseStatus:'ERROR'});io.writeJson=async()=>assert.fail('must not write');
 await assert.rejects(publishToExt5('a','local','A',io));assert.equal(io.uploads.length,0);
});
