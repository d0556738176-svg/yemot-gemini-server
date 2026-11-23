import test from 'node:test';
import assert from 'node:assert/strict';
import {createVoiceRecorder, recordingFolder, validRecording} from '../branch2-voice-recording.js';

function wav() {
  const b=Buffer.alloc(16044); b.write('RIFF'); b.writeUInt32LE(b.length-8,4);
  b.write('WAVE',8); b.write('fmt ',12); b.writeUInt32LE(16,16);
  b.writeUInt16LE(1,20); b.writeUInt16LE(1,22); b.writeUInt32LE(8000,24);
  b.writeUInt32LE(16000,28); b.writeUInt16LE(2,32); b.writeUInt16LE(16,34);
  b.write('data',36); b.writeUInt32LE(16000,40); return b;
}
function setup(download=async()=>({data:wav()})) {
  const calls=[], folders=new Set();
  const api=async(method,p)=>{
    calls.push({method,...p});
    if(method==='GetTextFile')return folders.has(p.what)?{responseStatus:'OK',contents:'branch2_voice_work=yes'}:{responseStatus:'ERROR',message:'File does not exist'};
    if(method==='UploadTextFile')folders.add(p.what);
    return {responseStatus:'OK'};
  };
  const r=createVoiceRecorder({api,download,wait:async()=>{},log:{}});
  const options=[];
  const call={read:async(messages,mode,o)=>{options.push(o);assert.equal(mode,'record');return o.path+'/'+o.file_name+'.wav';}};
  return {r,call,calls,options};
}
test('simultaneous calls record outside the full /2 directory with unique names and clean up only their files',async()=>{
  const x=setup(); const [a,b]=await Promise.all([x.r.capture(x.call,[{type:'text',data:'בדיקה'}],1),x.r.capture(x.call,[{type:'text',data:'בדיקה'}],2)]);
  assert.ok(validRecording(a)&&validRecording(b));
  assert.notEqual(x.options[0].file_name,x.options[1].file_name);
  assert.notEqual(x.options[0].val_name,x.options[1].val_name);
  assert.match(x.options[0].path,/^\/2\/voice-input\/\d{10}$/);
  assert.equal(x.calls.filter(c=>c.method==='UploadTextFile').length,1);
  const removed=x.calls.filter(c=>c.method==='FileAction');assert.equal(removed.length,2);
  assert.ok(removed.every(c=>c.what.startsWith('ivr2:/2/voice-input/')));
});
test('JSON error bodies never reach transcription; a delayed valid recording is retried',async()=>{
  let attempts=0;const x=setup(async()=>({data:++attempts===1?Buffer.from('{"responseStatus":"ERROR"}'):wav()}));
  assert.ok(validRecording(await x.r.capture(x.call,[{type:'text',data:'בדיקה'}],1)));
  assert.equal(attempts,2);
});
test('persistent corrupt audio and empty recording return actionable errors without deleting existing files',async()=>{
  const x=setup(async()=>({data:Buffer.from('not audio')}));
  await assert.rejects(x.r.capture(x.call,[{}],1),{code:'recording_invalid'});
  await assert.rejects(x.r.capture({read:async()=> 'None'},[{}],2),{code:'recording_empty'});
  assert.equal(x.calls.filter(c=>c.method==='FileAction').length,0);
});
test('a returned path outside this capture is neither downloaded nor deleted',async()=>{
  let downloads=0;const x=setup(async()=>{downloads++;return {data:wav()};});
  await assert.rejects(x.r.capture({read:async()=>'/2/999.wav'},[{}],1),{code:'recording_path'});
  assert.equal(downloads,0);assert.equal(x.calls.filter(c=>c.method==='FileAction').length,0);
});
test('hourly folder changes and empty WAV/JSON are rejected',()=>{
  assert.notEqual(recordingFolder(new Date('2026-11-23T10:00Z')),recordingFolder(new Date('2026-11-23T11:00Z')));
  assert.equal(validRecording(Buffer.alloc(44)),false);assert.equal(validRecording('{}'),false);
});
test('an unfinished WAV header is retried until the file is complete, without rewriting samples',async()=>{
  const incomplete=wav(); incomplete.writeUInt32LE(52,4); incomplete.writeUInt32LE(0,40);
  assert.equal(validRecording(incomplete),false);
  let attempts=0;const good=wav();const x=setup(async()=>({data:++attempts===1?incomplete:good}));
  assert.deepEqual(await x.r.capture(x.call,[{}],1),good);
  assert.equal(attempts,2);assert.equal(incomplete.readUInt32LE(40),0);
});
