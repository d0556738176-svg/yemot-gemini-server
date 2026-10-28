import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import vm from 'node:vm';
import {progressAnnouncement} from './youtube-playback-progress.js';
test('first and repeated hold responses use spoken text before ordered playback',async()=>{
 const source=await fs.readFile(new URL('./server.js',import.meta.url),'utf8');
 const start=source.indexOf('async function playSelected(');
 const fn=source.slice(start,source.indexOf('\n  try {\n    while(true)',start));
 let clock=0;const holds=[];const paths=['/2/youtubeaudio/abc/001'];
 const state={status:'running',progress:{stage:'provider'}};
 const ctx=vm.createContext({Date:{now:()=>1000*clock++},setTimeout:fn=>fn(),process:{env:{}},console:{info(){}},progressAnnouncement,sanitizeForYemot:x=>x,
  startYouTubePlaybackJob:()=>state,video:{videoId:'EZeWxl7N2DI',title:'test'},
  call:{read:async messages=>{holds.push(messages);if(holds.length===2){state.status='ready';state.paths=paths;}},id_list_message:m=>m}});
 const playback=await vm.runInContext(fn+';playSelected(call,video)',ctx);
 assert.equal(holds.length,2);
 assert.ok(holds.every(m=>m.length===1&&m[0].type==='text'));
 assert.ok(holds[0][0].data.includes('מנוע ההורדה'));
 assert.ok(holds[1][0].data.includes('נא להמתין'));
 assert.equal(playback.length,2);
});
