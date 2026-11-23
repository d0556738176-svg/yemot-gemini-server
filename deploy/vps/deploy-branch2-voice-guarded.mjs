// Owner-authorized deployment, gated on no calls, no active download jobs, clean tree.
import {readFileSync,writeFileSync,renameSync} from 'node:fs';
import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
const env={};for(const l of readFileSync('/opt/yemot/ext2.env','utf8').split('\n')){const m=l.match(/^([A-Z0-9_]+)="(.*)"$/);if(m)env[m[1]]=m[2];}
const token=env.YEMOT_API_KEY||env.YEMOT_API_USERNAME+':'+env.YEMOT_API_PASSWORD;
const incoming=await (await fetch('https://www.call2all.co.il/ym/api/GetIncomingCalls',{method:'POST',body:new URLSearchParams({token}),signal:AbortSignal.timeout(20000)})).json();
if(incoming.responseStatus!=='OK'||!Array.isArray(incoming.calls))throw Error('Cannot verify active calls');
console.log('ACTIVE_CALLS',incoming.calls.length);
if(incoming.calls.length)throw Error('Active calls: deployment deferred');
const port=env.PORT||'3000';
const jobs=await (await fetch('http://127.0.0.1:'+port+'/branch2-saved?recent=1',{signal:AbortSignal.timeout(10000)})).json();
if(!Array.isArray(jobs.audio)||!Array.isArray(jobs.video))throw Error('Cannot verify active download jobs');
const active=[...jobs.audio,...jobs.video].filter(j=>!['done','failed','error','complete','ready','cancelled'].includes(String(j.status||'')));
console.log('ACTIVE_DOWNLOAD_JOBS',active.length);
if(active.length)throw Error('Downloads active: deployment deferred');
const git=(...a)=>execFileSync('git',['-C','/opt/yemot/ext2',...a],{encoding:'utf8'}).trim();
const dirty=git('status','--porcelain').split('\n').filter(Boolean);
if(dirty.some(l=>l.slice(3)!=='package-lock.json'))throw Error('Other working tree changes; deployment deferred');
const lockHash=()=>createHash('sha256').update(readFileSync('/opt/yemot/ext2/package-lock.json')).digest('hex');
const originalLock=lockHash();
git('fetch','-q','origin','work/branch-2-confirm-yes-20261025');
const want=git('rev-parse','origin/work/branch-2-confirm-yes-20261025');
if(want!=='f48d4d6711479ffa4b78962988c2424938f35770')throw Error('Branch advanced; deployment deferred for review');
if(git('diff','--name-only','HEAD',want).split('\n').includes('package-lock.json'))throw Error('Deployment would change local dependency lock');
git('merge','--ff-only',want);
if(lockHash()!==originalLock)throw Error('Dependency lock changed unexpectedly');
execFileSync('node',['--check','/opt/yemot/ext2/server.js']);
execFileSync('node',['--test','/opt/yemot/ext2/test/branch2-voice-recording.test.js'],{stdio:'inherit'});
// Check calls again immediately before the restart.
const again=await (await fetch('https://www.call2all.co.il/ym/api/GetIncomingCalls',{method:'POST',body:new URLSearchParams({token}),signal:AbortSignal.timeout(20000)})).json();
if(again.responseStatus!=='OK'||!Array.isArray(again.calls)||again.calls.length)throw Error('Call arrived: restart deferred');
execFileSync('systemctl',['restart','yemot-ext2']);
const state=execFileSync('systemctl',['is-active','yemot-ext2'],{encoding:'utf8'}).trim();
if(state!=='active')throw Error('Service not active');
writeFileSync('/opt/yemot/.running-ext2.tmp',want+'\n');renameSync('/opt/yemot/.running-ext2.tmp','/opt/yemot/.running-ext2');
console.log('EXT2_DEPLOYED_AND_ACTIVE',want);
