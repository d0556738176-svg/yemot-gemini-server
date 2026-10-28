import test from 'node:test';
import assert from 'node:assert/strict';
import {prepareYouTubePlayback, validPlaybackPaths} from './youtube-playback-prepare.js';

const safe='/2/youtubeaudio/3044324d764e574f566b30/001';
const video={videoId:'0D2MvNWOVk0',title:'test'};
const silent={info(){},warn(){}};
const env={YOUTUBE_AUDIO_WORKER_URL:'https://worker.invalid',YOUTUBE_AUDIO_WORKER_SECRET:'test'};
const reply=paths=>async()=>({ok:true,status:200,json:async()=>({status:'ready',playbackPaths:paths})});

test('reject every protocol delimiter and malformed list without salvaging partial lists',()=>{
 for(const paths of [[],null,[null],[123],[''],[safe,''],[safe,'/2/youtube-authorized/id-001'],[safe+'.wav'],['ivr2:'+safe],['/2/a&go_to_folder=/'],['/2/a|b'],['/2/a"b'],["/2/a'b"],['/2/../001']]) {
  assert.equal(validPlaybackPaths(paths),false,JSON.stringify(paths));
 }
 assert.equal(validPlaybackPaths([safe,'/2/youtubeaudio/abc_123/002']),true);
});

test('old worker paths fall back instead of reaching the phone serializer',async()=>{
 for(const paths of [['/2/youtube-authorized/0D2MvNWOVk0-001'],[safe,null],[safe+'.wav']]){
  let calls=0;
  const result=await prepareYouTubePlayback(video,{env,fetchImpl:reply(paths),log:silent,downloadToYemot:async()=>{calls++;return {playbackPaths:[safe]};}});
  assert.equal(calls,1);assert.equal(result.via,'direct');
  assert.deepEqual(result.playbackPaths,[safe]);
  assert.equal(result.attempts[0].code,'invalid_playback_paths');
 }
});

test('valid worker paths pass unchanged and do not duplicate preparation',async()=>{
 const result=await prepareYouTubePlayback(video,{env,fetchImpl:reply([safe]),log:silent,downloadToYemot:async()=>{assert.fail('unexpected fallback');}});
 assert.equal(result.via,'worker');assert.deepEqual(result.playbackPaths,[safe]);
});

test('bad direct paths fail explicitly before a playback job becomes ready',async()=>{
 await assert.rejects(prepareYouTubePlayback(video,{env:{},log:silent,downloadToYemot:async()=>({playbackPaths:['/2/youtube-authorized/id-001']})}),e=>e.code==='invalid_playback_paths');
});

test('worker 502 still falls back to safe direct paths',async()=>{
 const result=await prepareYouTubePlayback(video,{env,log:silent,fetchImpl:async()=>({ok:false,status:502,json:async()=>{throw Error('not JSON');}}),downloadToYemot:async()=>({playbackPaths:[safe]})});
 assert.equal(result.via,'direct');assert.equal(result.attempts[0].code,'worker_unreachable');
});
