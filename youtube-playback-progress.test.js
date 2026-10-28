import test from 'node:test';
import assert from 'node:assert/strict';
import {progressAnnouncement} from './youtube-playback-progress.js';
import {prepareYouTubePlayback} from './youtube-playback-prepare.js';
test('provider stage never invents percentage even if stale numbers are present',()=>{
 const r=progressAnnouncement({stage:'provider',bytes:50,totalBytes:100},{},0);
 assert.ok(r.text.includes('אין דיווח אחוזים'));assert.ok(!/\d/.test(r.text));
});
test('transfer percentage uses received bytes and declared total only',()=>{
 assert.ok(progressAnnouncement({stage:'transferring',bytes:40,totalBytes:100},{},0).text.includes('40 אחוז'));
 for(const totalBytes of [null,0,undefined,NaN]){
  assert.ok(!/\d+ אחוז/.test(progressAnnouncement({stage:'transferring',bytes:40,totalBytes},{},0).text));
 }
});
test('100 percent is announced only after transfer completion',()=>{
 assert.ok(progressAnnouncement({stage:'transferring',bytes:100,totalBytes:100},{},0).text.includes('99 אחוז'));
 assert.ok(progressAnnouncement({stage:'converting'},{},0).text.includes('הושלמה במאה אחוז'));
});
test('repeat messages throttled, new stage announced, periodic reminder retained',()=>{
 const first=progressAnnouncement({stage:'provider'},{},0);
 assert.equal(progressAnnouncement({stage:'provider'},first.state,10000),null);
 assert.ok(progressAnnouncement({stage:'provider'},first.state,35000));
 assert.ok(progressAnnouncement({stage:'converting'},first.state,1000));
});
test('percentage changes coalesced, latest actual value announced',()=>{
 const first=progressAnnouncement({stage:'transferring',bytes:20,totalBytes:100},{},0);
 assert.equal(progressAnnouncement({stage:'transferring',bytes:60,totalBytes:100},first.state,3000),null);
 assert.ok(progressAnnouncement({stage:'transferring',bytes:80,totalBytes:100},first.state,12000).text.includes('80 אחוז'));
});
test('upload progress refers to completed verified chunks, not download percentage',()=>{
 const text=progressAnnouncement({stage:'uploading',completed:3,total:9},{},0).text;
 assert.ok(text.includes('הושלמו ואומתו 3 מתוך 9'));assert.ok(!text.includes('אחוז'));
});
test('preparation forwards progress callback and skips downloader on cached result',async()=>{
 const seen=[];const paths=['/2/youtubeaudio/abc/001'];const log={info(){},warn(){}};
 await prepareYouTubePlayback({videoId:'abcdefghijk'},{env:{},log,onProgress:p=>seen.push(p.stage),downloadToYemot:async(id,o)=>{o.onProgress({stage:'converting'});return {playbackPaths:paths};}});
 assert.deepEqual(seen,['checking','converting']);
 seen.length=0;
 await prepareYouTubePlayback({videoId:'abcdefghijk'},{env:{},log,onProgress:p=>seen.push(p.stage),lookupCached:async()=>({playbackPaths:paths}),downloadToYemot:async()=>assert.fail('cached playback must not download')});
 assert.deepEqual(seen,['checking','cached']);
});
