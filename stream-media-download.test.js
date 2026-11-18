import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { downloadStreamMedia, streamDownloadArgs, streamDownloaderPath, streamVideoSelection } from './stream-media-download.js';
import { registerWebItem } from './web-items.js';
import { directDownload } from './youtube-direct.js';

test('stream fallback stays optional and enforces bounded, complete downloads',()=>{
  assert.equal(streamDownloaderPath({N_M3U8DL_RE_PATH:'/nonexistent/tool'}),null);
  const a=streamDownloadArgs({url:'https://cdn.example/master.m3u8',referer:'https://example.com/',httpHeaders:{Cookie:'secret','User-Agent':'Playback-UA'}},'/tmp/stage','/usr/bin/ffmpeg');
  assert.ok(a.includes('2'));assert.ok(a.includes('--check-segments-count'));assert.ok(a.includes('User-Agent: Playback-UA'));assert.ok(!a.some(x=>x.includes('secret')));
});

test('unavailable streaming tool leaves no output',async()=>{
  await assert.rejects(downloadStreamMedia({url:'https://example.com/master.m3u8'},'/tmp/should-not-be-created',{bin:null}),{code:'stream_unavailable'});
});

test('stream selection honors ordinary video ceilings and keeps best audio',()=>{
  for(const max of [90,144,360,480,720,1080,2160]){
    const selection=streamVideoSelection('video',max);
    const pattern=new RegExp(selection.slice(4,-':for=best'.length));
    for(let h=1;h<=2200;h++)assert.equal(pattern.test('1920x'+h),h<=max,'height '+h+' at ceiling '+max);
  }
  assert.equal(streamVideoSelection('audio',480),'for=best');
  const args=streamDownloadArgs({url:'https://cdn.example/master.m3u8'},'/tmp/stage','ffmpeg',{mode:'video',height:1080});
  assert.equal(args[args.indexOf('--select-video')+1],streamVideoSelection('video',1080));
  assert.equal(args[args.indexOf('--select-audio')+1],'for=best');
  assert.ok(!args.includes('for=worst'));
});

test('real streaming adapter downloads protected HLS in video and audio modes', {skip:!process.env.NM_TEST_BIN},async t=>{
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'stream-integration-'));
  let base;
  execFileSync('/usr/bin/ffmpeg',['-hide_banner','-loglevel','error','-y','-f','lavfi','-i','color=c=black:s=160x90:r=10','-f','lavfi','-i','sine=frequency=440:sample_rate=16000','-t','6','-c:v','libx264','-c:a','aac','-f','hls','-hls_time','10','-hls_list_size','0',path.join(dir,'stream.m3u8')]);
  execFileSync('/usr/bin/ffmpeg',['-hide_banner','-loglevel','error','-y','-f','lavfi','-i','color=c=black:s=320x180:r=10','-f','lavfi','-i','sine=frequency=440:sample_rate=16000','-t','6','-c:v','libx264','-c:a','aac','-f','hls','-hls_time','10','-hls_list_size','0',path.join(dir,'high.m3u8')]);
  await fs.writeFile(path.join(dir,'master.m3u8'),'#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=200000,RESOLUTION=160x90\nstream.m3u8\n#EXT-X-STREAM-INF:BANDWIDTH=500000,RESOLUTION=320x180\nhigh.m3u8\n');
  const server=http.createServer(async(req,res)=>{
    if(req.headers.referer!=='https://example.com/episode'||req.headers['user-agent']!=='Playback-UA'){res.writeHead(403).end();return;}
    const name=req.url?.slice(1);if(!['stream.m3u8','stream0.ts','high.m3u8','high0.ts','master.m3u8'].includes(name)){res.writeHead(404).end();return;}
    const b=await fs.readFile(path.join(dir,name));res.setHeader('content-type',name.endsWith('m3u8')?'application/vnd.apple.mpegurl':'video/mp2t');res.setHeader('content-length',b.length);res.end(b);
  });
  await new Promise(r=>server.listen(0,'127.0.0.1',r));base='http://127.0.0.1:'+server.address().port;
  t.after(async()=>{server.close();await fs.rm(dir,{recursive:true,force:true});});
  const web={url:base+'/stream.m3u8',title:'Fixture',referer:'https://example.com/episode',httpHeaders:{'User-Agent':'Playback-UA'},hasVideo:true,hasAudio:true};
  const output=path.join(dir,'output.mp4');
  const old=process.env.N_M3U8DL_RE_PATH;process.env.N_M3U8DL_RE_PATH=process.env.NM_TEST_BIN;
  t.after(()=>{if(old===undefined)delete process.env.N_M3U8DL_RE_PATH;else process.env.N_M3U8DL_RE_PATH=old;});
  const id=registerWebItem(web);
  const r=await directDownload(id,output,{mode:'video',ffmpegPath:'/usr/bin/ffmpeg',withCaptions:false,maxBytes:1000000,log:{warn(){},info(){}}});
  assert.equal(r.client,'N_m3u8DL-RE');assert.ok(r.bytes>0);
  const info=JSON.parse(execFileSync('/usr/bin/ffprobe',['-v','error','-show_entries','stream=codec_type:format=duration','-of','json',output],{encoding:'utf8'}));
  assert.ok(info.streams.some(x=>x.codec_type==='video'));assert.ok(info.streams.some(x=>x.codec_type==='audio'));assert.ok(Number(info.format.duration)>=6);
  const multiId=registerWebItem({...web,url:base+'/master.m3u8'});
  for(const ceiling of [90,180]){
    const selected=path.join(dir,'quality_'+ceiling+'.mp4');
    const result=await directDownload(multiId,selected,{mode:'video',height:ceiling,ffmpegPath:'/usr/bin/ffmpeg',withCaptions:false,maxBytes:1000000,log:{info(){},warn(){}}});
    assert.equal(result.client,'N_m3u8DL-RE');
    const q=JSON.parse(execFileSync('/usr/bin/ffprobe',['-v','error','-select_streams','v:0','-show_entries','stream=height','-of','json',selected],{encoding:'utf8'}));
    assert.equal(q.streams[0].height,ceiling);
  }
  const audio=path.join(dir,'audio.source');
  await downloadStreamMedia(web,audio,{bin:process.env.NM_TEST_BIN,mode:'audio',ffmpegPath:'/usr/bin/ffmpeg',maxBytes:1000000});
  const ai=JSON.parse(execFileSync('/usr/bin/ffprobe',['-v','error','-show_entries','stream=codec_type','-of','json',audio],{encoding:'utf8'}));
  assert.deepEqual(ai.streams.map(x=>x.codec_type),['audio']);
  if(process.env.YTDLP_TEST_BIN){
    process.env.N_M3U8DL_RE_PATH='/nonexistent/disabled-for-native-test';
    const native=path.join(dir,'native.source');
    const n=await directDownload(id,native,{bin:process.env.YTDLP_TEST_BIN,mode:'audio',ffmpegPath:'/usr/bin/ffmpeg',withCaptions:false,maxBytes:1000000,log:{info(){},warn(){}}});
    assert.ok(n.bytes>0);
    const ni=JSON.parse(execFileSync('/usr/bin/ffprobe',['-v','error','-show_entries','stream=codec_type','-of','json',native],{encoding:'utf8'}));
    assert.ok(ni.streams.some(x=>x.codec_type==='audio'));
  }
});
