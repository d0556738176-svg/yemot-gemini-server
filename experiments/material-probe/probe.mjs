import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {createRequire} from 'node:module';
import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';

export function classify(message='') {
  if (/confirm.*not a bot|LOGIN_REQUIRED/i.test(message)) return 'YOUTUBE_BOT_CHALLENGE';
  if (/429|Too Many Requests/i.test(message)) return 'RATE_LIMITED';
  if (/certificate verify|CERTIFICATE_VERIFY_FAILED/i.test(message)) return 'TLS_CERTIFICATE_ERROR';
  if (/403|Forbidden/i.test(message)) return 'HTTP_FORBIDDEN';
  if (/not available|unavailable|removed|private video/i.test(message)) return 'VIDEO_UNAVAILABLE';
  if (/timed? ?out|timeout/i.test(message)) return 'TIMEOUT';
  return 'DOWNLOAD_FAILED';
}

export async function command(binary,args,timeoutMs=90000) {
  return new Promise((resolve,reject)=>{
    const c=spawn(binary,args,{stdio:['ignore','pipe','pipe']});
    let out='',err='';
    c.stdout.on('data',b=>{out=(out+b).slice(-65536)});
    c.stderr.on('data',b=>{err=(err+b).slice(-65536)});
    const timer=setTimeout(()=>{c.kill('SIGKILL')},timeoutMs);
    c.on('error',e=>{clearTimeout(timer);reject(new Error(e.code||'PROCESS_FAILED'))});
    c.on('close',(code,signal)=>{clearTimeout(timer);resolve({code,signal,out,err})});
  });
}

async function audioFacts(file) {
  const r=await command('ffprobe',['-v','error','-show_streams','-show_format','-of','json',file],15000);
  if(r.code!==0) throw new Error('AUDIO_VALIDATION_FAILED');
  const body=JSON.parse(r.out), a=body.streams?.find(s=>s.codec_type==='audio');
  const duration=Number(body.format?.duration);
  if(!a || !Number.isFinite(duration) || duration<=0) throw new Error('AUDIO_VALIDATION_FAILED');
  return {bytes:(await fs.stat(file)).size,durationSec:duration,codec:a.codec_name,channels:a.channels,sampleRate:Number(a.sample_rate)};
}

export async function uploadAndVerify(wav,remotePath,{token,fetchImpl=fetch}={}) {
  if(!token) throw new Error('YEMOT_CREDENTIAL_NOT_CONFIGURED');
  if(!/^ivr2:\/2\/material-selftest\/[A-Za-z0-9_-]+\/001\.wav$/.test(remotePath)) throw new Error('UNSAFE_TEST_PATH');
  const form=new FormData();
  form.set('token',token); form.set('path',remotePath);
  form.set('convertAudio','0'); form.set('autoNumbering','false');
  const bytes=await fs.readFile(wav);
  form.set('file',new Blob([bytes],{type:'audio/wav'}),'001.wav');
  const r=await fetchImpl('https://www.call2all.co.il/ym/api/UploadFile',{method:'POST',body:form,signal:AbortSignal.timeout(30000)});
  let body; try {body=await r.json()} catch {throw new Error('YEMOT_INVALID_JSON')}
  if(!r.ok || body.responseStatus!=='OK' || body.success===false) throw new Error('YEMOT_UPLOAD_REJECTED');
  const params=new URLSearchParams({token,path:remotePath});
  const downloaded=await fetchImpl('https://www.call2all.co.il/ym/api/DownloadFile',{method:'POST',body:params,signal:AbortSignal.timeout(30000)});
  if(!downloaded.ok) throw new Error('YEMOT_VERIFY_HTTP_ERROR');
  const buf=Buffer.from(await downloaded.arrayBuffer());
  if(buf.length!==bytes.length || !buf.equals(bytes)) throw new Error('YEMOT_READBACK_MISMATCH');
  return {responseStatus:'OK',verifiedBytes:buf.length,remotePath};
}

export async function runProbe() {
  const report={startedAt:new Date().toISOString(),environment:process.env.GITHUB_ACTIONS==='true'?'github-actions':'local-cloud',materialCommit:process.env.MATERIAL_COMMIT||null,yemotCredentialConfigured:Boolean(process.env.YEMOT_API_KEY),download:{status:'not_attempted'},conversion:{status:'not_attempted'},upload:{status:'not_attempted'},fullChainVerified:false,attempts:[]};
  const temp=await fs.mkdtemp(path.join(os.tmpdir(),'material-probe-'));
  const reportPath=path.resolve(process.env.PROBE_REPORT||'material-probe-report.json');
  const originalCwd=process.cwd();
  try {
    const backend=path.resolve(process.env.MATERIAL_BACKEND||'upstream/backend');
    process.chdir(backend);
    const require=createRequire(path.join(backend,'package.json'));
    const config=require('./config.js'); config.initialize();
    config.setConfigItem('ytdl_default_downloader','yt-dlp');
    const downloader=require('./youtube-dl.js');
    const version=await command(path.join(backend,'appdata/bin/yt-dlp'),['--version'],10000);
    if(version.code!==0) throw new Error('DOWNLOADER_NOT_READY');
    report.ytDlpVersion=version.out.trim();
    const videoIds=process.env.PROBE_VIDEO_ID?[process.env.PROBE_VIDEO_ID]:['BaW_jenozKc','jNQXAC9IVRw'];
    let source;
    for(const videoId of videoIds) {
      if(!/^[A-Za-z0-9_-]{11}$/.test(videoId)) throw new Error('INVALID_VIDEO_ID');
      const dir=path.join(temp,videoId); await fs.mkdir(dir);
      const args=['--no-playlist','--no-progress','--socket-timeout','12','--retries','0','--extractor-retries','0','--max-filesize','32M','--match-filters','duration <= 180','-f','bestaudio/best','-o',path.join(dir,'source.%(ext)s')];
      const started=Date.now();
      const {child_process,callback}=await downloader.runYoutubeDL('https://www.youtube.com/watch?v='+videoId,args);
      const timer=setTimeout(()=>child_process.kill('SIGKILL'),60000);
      let result; try {result=await callback} finally {clearTimeout(timer)}
      const message=String(result.err?.stderr||result.err?.message||result.err||'');
      const files=(await fs.readdir(dir)).filter(n=>/^source\./.test(n)&&!n.endsWith('.part')&&!n.endsWith('.ytdl'));
      if(child_process.exitCode===0 && files.length===1) {
        source=path.join(dir,files[0]);
        report.download={status:'success',videoId,...await audioFacts(source)};
        report.attempts.push({videoId,status:'success',ms:Date.now()-started}); break;
      }
      report.attempts.push({videoId,status:'failed',code:classify(message),ms:Date.now()-started});
    }
    if(!source) {report.download={status:'failed',code:report.attempts.at(-1)?.code||'DOWNLOAD_FAILED'};return report}
    const wav=path.join(temp,'001.wav');
    const converted=await command('ffmpeg',['-v','error','-nostdin','-y','-i',source,'-t','20','-vn','-ac','1','-ar','8000','-c:a','pcm_s16le',wav],30000);
    if(converted.code!==0) throw new Error('CONVERSION_FAILED');
    const facts=await audioFacts(wav);
    if(facts.codec!=='pcm_s16le'||facts.channels!==1||facts.sampleRate!==8000) throw new Error('INVALID_YEMOT_AUDIO');
    report.conversion={status:'success',...facts};
    if(!process.env.YEMOT_API_KEY) {report.upload={status:'blocked',code:'YEMOT_CREDENTIAL_NOT_CONFIGURED'};return report}
    const runId=String(process.env.GITHUB_RUN_ID||Date.now()).replace(/[^A-Za-z0-9_-]/g,'').slice(0,40);
    report.upload={status:'success',...await uploadAndVerify(wav,'ivr2:/2/material-selftest/'+runId+'/001.wav',{token:process.env.YEMOT_API_KEY})};
    report.fullChainVerified=true;
    return report;
  } catch(error) {
    // Error messages from external code may include signed URLs or credentials.
    // Record only our controlled codes, never raw exception objects.
    const code=String(error?.message||'');
    report.error=/^[A-Z][A-Z0-9_]+$/.test(code)?code:'PROBE_RUNTIME_ERROR';
    return report;
  } finally {
    process.chdir(originalCwd);
    await fs.rm(temp,{recursive:true,force:true});
    await fs.writeFile(reportPath,JSON.stringify(report,null,2)+'\n');
    console.log(JSON.stringify(report,null,2));
  }
}

if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)) {
  const report=await runProbe();
  process.exitCode=report.fullChainVerified?0:2;
}
