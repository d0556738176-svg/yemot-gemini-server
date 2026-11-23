// Replay the owner's latest failed recording through the corrected header and ASR.
import {readFileSync} from 'node:fs';
for(const l of readFileSync('/opt/yemot/ext2.env','utf8').split('\n')){const m=l.match(/^([A-Z0-9_]+)="(.*)"$/);if(m)process.env[m[1]]=m[2];}
const token=process.env.YEMOT_API_KEY||process.env.YEMOT_API_USERNAME+':'+process.env.YEMOT_API_PASSWORD;
const u=new URL('https://www.call2all.co.il/ym/api/DownloadFile');u.searchParams.set('token',token);u.searchParams.set('path','ivr2:/2/1005.wav');
const r=await fetch(u,{signal:AbortSignal.timeout(20000)});const original=Buffer.from(await r.arrayBuffer());
const source=await fetch('https://raw.githubusercontent.com/d0556738176-svg/yemot-gemini-server/63531e5/branch2-voice-recording.js');
const {repairRecordingWav,validRecording}=await import('data:text/javascript;base64,'+Buffer.from(await source.text()).toString('base64'));
const repaired=repairRecordingWav(original);
console.log('WAV_REPAIR',JSON.stringify({bytes:original.length,oldRiffSize:original.readUInt32LE(4),newRiffSize:repaired.readUInt32LE(4),valid:validRecording(repaired)}));
if(!validRecording(repaired))throw Error('Repair failed');
const dg=await fetch('https://api.deepgram.com/v1/listen?model=nova-3&language=he&smart_format=true&punctuate=true',{method:'POST',headers:{Authorization:'Token '+process.env.DEEPGRAM_API_KEY,'Content-Type':'audio/wav'},body:repaired,signal:AbortSignal.timeout(20000)});
const j=await dg.json(),text=String(j.results?.channels?.[0]?.alternatives?.[0]?.transcript||'').trim();
console.log('REPLAY_ASR_RESULT',JSON.stringify({status:dg.status,chars:text.length,weatherTestRecognized:/מזג|אוויר|ישראל/.test(text),error:j.err_msg||j.message||null}));
if(!dg.ok||!text)throw Error('Repaired recording not transcribed');
console.log('RECORDING_REPAIR_ASR_VERIFIED');
