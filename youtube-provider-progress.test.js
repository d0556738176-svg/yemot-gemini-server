import test from 'node:test';
import assert from 'node:assert/strict';
import {parseProviderProgress,boundedLogText} from './youtube-provider-progress.js';
import {createApifyResolver,apifyReceiptPath} from './youtube-apify-source.js';
import {progressAnnouncement} from './youtube-playback-progress.js';
const id='EF8C4v7JIbA';
const line=n=>'2026-11-02T11:22:03.403Z [#a8cd39 5.2MiB/47MiB('+n+'%) CN:4 DL:96KiB ETA:7m30s]';
test('real aria2 and yt-dlp reports parse, elapsed time and arbitrary percentages do not',()=>{
 assert.equal(parseProviderProgress(line(11)).percent,11);
 assert.equal(parseProviderProgress('[download] 42.5% of 47.0MiB at 96KiB/s').percent,42);
 assert.equal(parseProviderProgress('Run is 80% ready, elapsed 30 minutes'),null);
 assert.equal(parseProviderProgress('[download] 100% of 47MiB').percent,99);
});
test('failure or retry invalidates the previous transfer, newest attempt may move backwards',()=>{
 for(const suffix of ['ERROR SSL failure','download stalled','retrying on a fresh exit','starting download'])assert.equal(parseProviderProgress(line(96)+'\n'+suffix),null);
 assert.equal(parseProviderProgress(line(96)+'\nERROR failed\n'+line(4)).percent,4);
});
test('bounded log read rejects oversized data rather than presenting an old percentage',async()=>{
 await assert.rejects(boundedLogText(new Response(line(96)+'x'.repeat(100)),20),/too large/);
});
test('phone distinguishes stale provider percentage, unknown progress and transfer stage',()=>{
 assert.match(progressAnnouncement({stage:'provider',providerPercent:42},{},0).text,/42 אחוז מקובץ המקור/);
 const stale=progressAnnouncement({stage:'provider',providerPercent:42,providerStale:true},{},0).text;
 assert.match(stale,/ממתין לעדכון חדש/);assert.match(stale,/עדיין אינו מוכן להשמעה/);
 assert.match(progressAnnouncement({stage:'provider',providerPercent:null},{},0).text,/אין דיווח אחוזים/);
});
test('percentage survives a process restart and the same run resumes without another POST',async()=>{
 const records=new Map([[apifyReceiptPath(id),{version:1,videoId:id,actorId:'memo23~youtube-video-downloader',runId:'saved',attemptCount:1}]]);
 const store={read:async p=>structuredClone(records.get(p)),write:async(p,v)=>records.set(p,structuredClone(v))};
 let clock=Date.parse('2026-11-02T11:22:10Z'),posts=0,logsAvailable=true;
 const fetchImpl=async(u,o)=>{
  if(o.method==='POST'){posts++;assert.fail('resume may not start another download');}
  if(u.includes('/logs/')){if(!logsAvailable)throw Error('temporary log outage');return new Response(line(11));}
  return Response.json({data:{status:'RUNNING'}});
 };
 const make=()=>createApifyResolver({fetchImpl,now:()=>clock,sleep:async ms=>clock+=ms,log:{info(){},warn(){}}});
 const seen=[];
 await assert.rejects(make()(id,{APIFY_TOKEN:'fixture',BRANCH2_APIFY_WAIT_MS:'1000'},{store,onProgress:p=>seen.push(p)}),e=>e.code==='apify_pending');
 assert.equal(records.get(apifyReceiptPath(id)).progress.percent,11);
 logsAvailable=false;clock+=120000;const resumed=[];
 await assert.rejects(make()(id,{APIFY_TOKEN:'fixture',BRANCH2_APIFY_WAIT_MS:'1000'},{store,onProgress:p=>resumed.push(p)}),e=>e.code==='apify_pending');
 assert.ok(resumed.some(p=>p.providerPercent===11&&p.providerStale));assert.equal(posts,0);
});
test('failed saved run does not announce an old percentage as ongoing download',async()=>{
 const seen=[];const resolve=createApifyResolver({log:{info(){},warn(){}},fetchImpl:async(u,o)=>u.endsWith('/log')?new Response('ERROR download stalled'):Response.json({data:{status:'FAILED'}})});
 await assert.rejects(resolve(id,{APIFY_TOKEN:'fixture'},{store:{read:async()=>({version:1,videoId:id,actorId:'memo23~youtube-video-downloader',runId:'saved',progress:{runId:'saved',percent:96}}),write:async()=>assert.fail()},onProgress:p=>seen.push(p)}));
 assert.equal(seen.length,0);
});
