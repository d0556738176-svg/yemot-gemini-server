// Prepare only the dedicated temporary recording folder and verify binary reads.
import {readFileSync} from 'node:fs';
for(const l of readFileSync('/opt/yemot/ext2.env','utf8').split('\n')){const m=l.match(/^([A-Z0-9_]+)="(.*)"$/);if(m)process.env[m[1]]=m[2];}
const token=process.env.YEMOT_API_KEY||process.env.YEMOT_API_USERNAME+':'+process.env.YEMOT_API_PASSWORD;
const base='https://www.call2all.co.il/ym/api/';
async function api(method,params){const r=await fetch(base+method,{method:'POST',body:new URLSearchParams({token,...params}),signal:AbortSignal.timeout(20000)});return r.json();}
const src=await fetch('https://raw.githubusercontent.com/d0556738176-svg/yemot-gemini-server/c6d493c/branch2-voice-recording.js');if(!src.ok)throw Error('Cannot load reviewed module');
const {createVoiceRecorder,validRecording}=await import('data:text/javascript;base64,'+Buffer.from(await src.text()).toString('base64'));
const r=createVoiceRecorder({api,download:async()=>{}});
const ini=(await api('GetTextFile',{what:'ivr2:/2/ext.ini'})).contents;
const folder=await r.prepare();
const dir=await api('GetIVR2Dir',{path:'ivr2:/2'});
console.log('RECORDING_STORAGE_READY',folder);
console.log('ROOT_RECORDING_NAMES',JSON.stringify((dir.files||[]).slice(0,3).map(f=>f.name)));
const u=new URL(base+'DownloadFile');u.searchParams.set('token',token);u.searchParams.set('path','ivr2:/2/005.wav');
const b=Buffer.from(await (await fetch(u,{signal:AbortSignal.timeout(20000)})).arrayBuffer());
if(!validRecording(b))throw Error('Known recording failed binary validation');
if((await api('GetTextFile',{what:'ivr2:/2/ext.ini'})).contents!==ini)throw Error('Extension 2 configuration changed');
console.log('VOICE_STORAGE_CHECK_OK',JSON.stringify({bytes:b.length,mainExtensionConfigUnchanged:true}));
