// Never outputs credential values.
import {readFileSync} from 'node:fs';
import {execFileSync} from 'node:child_process';
const env={};for(const l of readFileSync('/opt/yemot/main.env','utf8').split('\n')){const m=l.match(/^([A-Z0-9_]+)="(.*)"$/);if(m)env[m[1]]=m[2];}
if(process.argv.includes('--calls')){
 const phone={};for(const l of readFileSync('/opt/yemot/ext2.env','utf8').split('\n')){const m=l.match(/^([A-Z0-9_]+)="(.*)"$/);if(m)phone[m[1]]=m[2];}
 const token=phone.YEMOT_API_USERNAME+':'+phone.YEMOT_API_PASSWORD;
 const r=await fetch('https://www.call2all.co.il/ym/api/GetIncomingCalls',{method:'POST',body:new URLSearchParams({token}),signal:AbortSignal.timeout(15000)});
 const j=await r.json();if(j.responseStatus!=='OK'||!Array.isArray(j.calls))throw Error('Cannot verify active calls');
 console.log('ACTIVE_CALLS',j.calls.length);if(j.calls.length)process.exitCode=2;
}else{
 const pid=execFileSync('systemctl',['show','yemot-main','--property=MainPID','--value'],{encoding:'utf8'}).trim();
 const pair=readFileSync('/proc/'+pid+'/environ','utf8').split('\0').find(x=>x.startsWith('SERPER_API_KEY='));
 const key=pair?.slice('SERPER_API_KEY='.length)||'';
 console.log('SERPER_KEY_SAVED',!!env.SERPER_API_KEY);
 console.log('SERPER_KEY_LOADED',!!key&&key===env.SERPER_API_KEY);
 if(!key||key!==env.SERPER_API_KEY)throw Error('Runtime key not loaded');
 const r=await fetch('https://google.serper.dev/search',{method:'POST',headers:{'X-API-KEY':key,'Content-Type':'application/json'},body:JSON.stringify({q:'weather in Israel',gl:'il',hl:'he',num:3}),signal:AbortSignal.timeout(20000)});
 const j=await r.json();console.log('SERPER_SEARCH_CHECK',JSON.stringify({status:r.status,results:j.organic?.length||0}));
 if(!r.ok||!j.organic?.length)throw Error('Serper search verification failed');
 console.log('SERPER_VERIFIED_OK');
}
