// Read-only: routing/recording metadata, no credentials or recording contents printed.
import {readFileSync} from 'node:fs';
const env={};for(const l of readFileSync('/opt/yemot/ext2.env','utf8').split('\n')){const m=l.match(/^([A-Z0-9_]+)="(.*)"$/);if(m)env[m[1]]=m[2];}
const token=env.YEMOT_API_KEY||env.YEMOT_TOKEN||(env.YEMOT_API_USERNAME+':'+env.YEMOT_API_PASSWORD);
async function api(method,params){const r=await fetch('https://www.call2all.co.il/ym/api/'+method,{method:'POST',body:new URLSearchParams({token,...params}),signal:AbortSignal.timeout(20000)});return r.json();}
const ini=await api('GetTextFile',{what:'ivr2:/2/ext.ini'});
console.log('ROUTE',ini.responseStatus);
console.log(String(ini.contents||'').split(/\r?\n/).filter(l=>/^(type|api_link|api_dir|api_record|api_hangup_send|record)/.test(l)).map(l=>l.replace(/\?.*$/,'')).join('\n'));
const dir=await api('GetIVR2Dir',{path:'ivr2:/2'});
console.log('DIRECTORY',dir.responseStatus,'files',dir.files?.length,'folders',dir.dirs?.length);
console.log('LAST_RECORDINGS',JSON.stringify((dir.files||[]).filter(f=>/\.wav$/i.test(f.name||'')).slice(-5).map(f=>({name:f.name,size:f.size,duration:f.duration,modified:f.mtime||f.date||f.modified}))));
console.log('KEYS_PRESENT',JSON.stringify({deepgram:!!env.DEEPGRAM_API_KEY,gemini:!!env.GEMINI_API_KEY}));
