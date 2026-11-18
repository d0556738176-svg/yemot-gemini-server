import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import * as W from './branch2-web-flow.js';

// Run the actual webFlow handler with phone/storage/download boundaries mocked.
// No production server startup, credentials, call or media download is involved.
const source = await fs.readFile(new URL('./server.js', import.meta.url), 'utf8');
const start = source.indexOf('  async function webFlow(mode) {');
const end = source.indexOf('\n  async function playSelected', start);
assert.ok(start >= 0 && end > start);
const body = source.slice(start, end)
  .replace("await import('./branch2-web-flow.js')", 'deps.W')
  .replace("await import('./web-media.js')", 'deps.media')
  .replace("await import('./branch2-search-history.js')", 'deps.history');
const run = new Function('deps', `
 const {call,callerPhone,branch2Store,sanitizeForYemot,playSelected,startYouTubeVideoJob,videoStartGate,liveListen}=deps;
 let tapNo=0;
 const console={info(){},warn(){}};
 class ExitError extends Error{}
 const isCallerHangupError=()=>false;
 ${body}
 return webFlow({q:'test episode'});
`);

function harness(keys, choice, { hasVideo = true } = {}) {
  const reads=[], audio=[], video=[];
  const items=Array.from({length:45},(_,i)=>({ id:'w'+String(i).padStart(10,'0'),title:'Result '+(i+1),site:'example.com',hasVideo,durationSec:60 }));
  const deps={W,callerPhone:'0000000000',branch2Store:{},sanitizeForYemot:x=>x,
    media:{searchWebMedia:async()=>({items,youtube:[]})},history:{addToHistory:async()=>{}},
    call:{read:async(messages,_type,opts)=>{
      const text=messages.map(x=>x.data).join(' '); reads.push({text,opts});
      if(text.includes('לבחירה הקש את מספר התוצאה')) return keys.shift()||'*';
      if(text.includes('להשמעה ולשמירה בתיקיית אודיו')) return choice;
      if(text.includes('להוספת כתובית בעברית')) return '2';
      return 'None';
    }},playSelected:async(_call,it)=>{audio.push(it);return 'played';},startYouTubeVideoJob:it=>{video.push(it);return {status:'running'};},
    videoStartGate:async()=>{throw Error('web result must not enter paid YouTube gate');},liveListen:async()=>({})
  };
  return {deps,reads,audio,video};
}

test('20 results per page, 0 shows 21-40, selecting 21 invokes audio pipeline', async()=>{
  const h=harness(['0','21'],'1');const r=await run(h.deps);
  assert.equal(r.play,'played');assert.equal(h.audio[0].title,'Result 21');
  const pages=h.reads.filter(x=>x.text.includes('לבחירה הקש את מספר התוצאה'));
  assert.ok(pages[0].text.includes('20, Result 20,'));assert.ok(!pages[0].text.includes('21, Result 21,'));
  assert.ok(pages[1].text.includes('21, Result 21,'));assert.ok(pages[1].text.includes('40, Result 40,'));assert.ok(!pages[1].text.includes('41, Result 41,'));
  assert.equal(pages[0].opts.max_digits,2);
});

test('two-digit choice and video option invoke existing video job', async()=>{
  const h=harness(['12','*'],'2');await run(h.deps);
  assert.equal(h.video.length,1);assert.equal(h.video[0].title,'Result 12');assert.equal(h.video[0].subtitles,false);assert.equal(h.audio.length,0);
});

test('audio-only result never offers or starts video',async()=>{
  const h=harness(['1','*'],'2',{hasVideo:false});await run(h.deps);
  const confirmation=h.reads.find(x=>x.text.includes('להשמעה ולשמירה בתיקיית אודיו'));
  assert.ok(!confirmation.text.includes('להורדת הסרטון'));assert.equal(h.video.length,0);
});

test('00 requests a new search without starting any download',async()=>{
  const h=harness(['00'],'1');assert.deepEqual(await run(h.deps),{});assert.equal(h.audio.length+h.video.length,0);
});
