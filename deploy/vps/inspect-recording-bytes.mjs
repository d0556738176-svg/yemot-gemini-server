// Read-only byte-integrity comparison; never prints recording contents.
import {readFileSync} from 'node:fs';
for(const l of readFileSync('/opt/yemot/ext2.env','utf8').split('\n')){const m=l.match(/^([A-Z0-9_]+)="(.*)"$/);if(m)process.env[m[1]]=m[2];}
const {default:YemotApi}=await import('/opt/yemot/ext2/node_modules/yemot-api/index.js');
const oldApi=new YemotApi(process.env.YEMOT_API_USERNAME,process.env.YEMOT_API_PASSWORD);
const old=await oldApi.download_file('ivr2:/2/1005.wav');
const token=process.env.YEMOT_API_KEY||process.env.YEMOT_API_USERNAME+':'+process.env.YEMOT_API_PASSWORD;
const u=new URL('https://www.call2all.co.il/ym/api/DownloadFile');u.searchParams.set('token',token);u.searchParams.set('path','ivr2:/2/1005.wav');
const r=await fetch(u,{signal:AbortSignal.timeout(20000)});const b=Buffer.from(await r.arrayBuffer());
console.log('RECORDING_BYTES_CHECK',JSON.stringify({oldType:typeof old.data,oldBuffer:Buffer.isBuffer(old.data),oldLength:old.data?.length,oldReplacementChars:typeof old.data==='string'?(old.data.match(/\ufffd/g)||[]).length:null,newBytes:b.length,newRiff:b.toString('ascii',0,4)==='RIFF',newWave:b.toString('ascii',8,12)==='WAVE',sameBytes:Buffer.isBuffer(old.data)?old.data.equals(b):typeof old.data==='string'?Buffer.from(old.data).equals(b):false}));
