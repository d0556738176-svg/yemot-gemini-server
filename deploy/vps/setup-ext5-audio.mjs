// One-time setup for the owner's additional audio library; preserves old settings.
import {readFileSync} from 'node:fs';
const env={};for(const l of readFileSync('/opt/yemot/ext2.env','utf8').split('\n')){const m=l.match(/^([A-Z0-9_]+)="(.*)"$/);if(m)env[m[1]]=m[2];}
const token=env.YEMOT_TOKEN||(env.YEMOT_API_USERNAME+':'+env.YEMOT_API_PASSWORD),base='https://www.call2all.co.il/ym/api/';
async function api(m,p={}){const r=await fetch(base+m,{method:'POST',body:new URLSearchParams({token,...p}),signal:AbortSignal.timeout(30000)});const j=await r.json();if(j.responseStatus!=='OK')throw new Error(m+' '+j.responseStatus);return j;}
const old=(await api('GetTextFile',{what:'ivr2:/5/ext.ini'})).contents||'';
if(!/ext5_web_audio_library=yes/.test(old)&&!(/type=go_to_folder/.test(old)&&/^go_to_folder=\/?\s*$/m.test(old)))throw new Error('Extension 5 has another active purpose; refusing to replace');
let backup=null;try{backup=await api('GetTextFile',{what:'ivr2:/2/youtubeaudio/ext5_config_backup.json'})}catch{}
if(!backup)await api('UploadTextFile',{what:'ivr2:/2/youtubeaudio/ext5_config_backup.json',contents:JSON.stringify({at:new Date().toISOString(),ini:old})});
const seven=(await api('GetTextFile',{what:'ivr2:/7/ext.ini'})).contents;
if(!/^type=playfile\s*$/m.test(seven))throw new Error('Cannot read playback template');
const ini=seven.split(/\r?\n/).filter(l=>!/^title=|^ext5_web_audio_library=/.test(l)).join('\n')+'\ntitle=הורדות שמע מכל האתרים\next5_web_audio_library=yes\n';
await api('UploadTextFile',{what:'ivr2:/5/ext.ini',contents:ini});
const after=(await api('GetTextFile',{what:'ivr2:/5/ext.ini'})).contents;
if(!after.includes('ext5_web_audio_library=yes')||!/^type=playfile\s*$/m.test(after))throw new Error('Read-back failed');
console.log('EXT5_CONFIG_VERIFIED; previous settings backed up; other extensions unchanged');
