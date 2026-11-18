import test from 'node:test';
import assert from 'node:assert/strict';
import {TV_CHANNELS,validSipDestination,branch2TvStatus,configureBranch2Tv} from '../branch2-live-tv.js';

test('channels preserve the exact six keypad choices',()=>{
 assert.deepEqual(TV_CHANNELS.map(c=>c.key),['1','2','3','4','5','6']);
 assert.deepEqual(TV_CHANNELS.map(c=>c.title),['כאן 11','ערוץ 12','ערוץ 13','ערוץ 14','איי 24 ניוז','ערוץ הכנסת']);
});
test('SIP routing refuses URLs and injection',()=>{
 assert.equal(validSipDestination('tv1@sip.example.org'),true);
 for(const v of ['https://tv.example/stream.m3u8','localhost?x=y','foo\\nbar','x&type=music_on_hold','']) assert.equal(validSipDestination(v),false);
});
test('configuration is off until all SIP destinations and flag exist',()=>{
 assert.equal(branch2TvStatus({}).ready,false);
 const env={BRANCH2_LIVE_TV_ENABLED:'true'};
 for(const c of TV_CHANNELS)env[c.env]=c.key+'@sip.example.org';
 assert.equal(branch2TvStatus(env).ready,true);
});
test('no Yemot broadcast module; children use external routing_ip',async()=>{
 const env={BRANCH2_LIVE_TV_ENABLED:'true'};
 for(const c of TV_CHANNELS)env[c.env]=c.key+'@sip.example.org';
 const calls=[];
 await configureBranch2Tv({updateExtension:async(p,v)=>calls.push([p,v]),publicUrl:'https://ivr.example.org',env});
 assert.equal(calls.length,7);
 for(const [path,opts] of calls.slice(0,6)){
   assert.match(path,/^ivr2:\/2\/8\/[1-6]$/);
   assert.equal(opts.type,'routing_ip');
   assert.ok(!('music_on_hold' in opts));
 }
 assert.equal(calls[6][0],'ivr2:/2/8');
});
