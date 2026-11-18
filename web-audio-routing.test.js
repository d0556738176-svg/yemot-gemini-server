import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { prepareYouTubePlayback } from './youtube-playback-prepare.js';
import { argsFor } from './youtube-direct.js';

test('web audio bypasses the YouTube worker and publisher fallback with its own budget',async()=>{
  let downloads=0;
  const r=await prepareYouTubePlayback({videoId:'w1234567890'}, {
    env:{YOUTUBE_AUDIO_WORKER_URL:'https://worker.example',YOUTUBE_AUDIO_WORKER_SECRET:'test',YOUTUBE_PLAYBACK_TOTAL_BUDGET_MS:'1',WEB_MEDIA_PLAYBACK_TOTAL_BUDGET_MS:'10000'},
    isWebMedia:async()=>true,
    fetchImpl:async()=>{throw Error('must not send web id to YouTube worker');},
    resolveAlternate:async()=>{throw Error('must not search YouTube publisher sources');},
    downloadToYemot:async(_id,{signal})=>{downloads++;await new Promise(r=>setTimeout(r,15));signal.throwIfAborted();return {playbackPaths:['/2/web_audio']};},
    log:{info(){},warn(){}}
  });
  assert.equal(downloads,1);assert.equal(r.via,'direct');assert.deepEqual(r.attempts,[]);
});

test('web audio allows a combined HLS stream; YouTube format choice stays unchanged',()=>{
  const web=argsFor('w1234567890','/tmp/source',{mode:'audio',target:'https://cdn.example/stream.m3u8'});
  assert.equal(web[web.indexOf('-f')+1],'bestaudio/best/best*');
  const yt=argsFor('abcdefghijk','/tmp/source',{mode:'audio'});
  assert.equal(yt[yt.indexOf('-f')+1],'bestaudio/best');
});

const source=await fs.readFile(new URL('./youtube-authorized-playback.js',import.meta.url),'utf8');
const a=source.indexOf('async function build(videoId,');
const b=source.indexOf('\nexport async function downloadAuthorizedAudioToYemot',a);
assert.ok(a>=0&&b>a);
const build=new Function('deps',`
 const {fs,os,path,process,webItem,downloadApifySource,downloadVisionAudio,fetchAuthorizedSource,preparePhoneAudio}=deps;
 const isApifyConfigured=()=>false,phoneRate=async()=>16000,console={info(){},warn(){}};
 ${source.slice(a,b)}
 return build('w1234567890');
`);

test('actual audio build uses the free web downloader without any paid API key',async()=>{
  let direct=0;
  await assert.rejects(build({fs,os,path,process:{env:{}},webItem:async()=>({url:'https://example.com/video'}),
    downloadApifySource:async()=>{direct++;return {title:'Web audio'};},
    downloadVisionAudio:async()=>{throw Error('wrong YouTube path');},fetchAuthorizedSource:async()=>{throw Error('wrong authorized source path');},
    preparePhoneAudio:async()=>{throw Object.assign(new Error('reached phone conversion'),{code:'conversion_reached'});}
  }),{code:'conversion_reached'});
  assert.equal(direct,1);
});
