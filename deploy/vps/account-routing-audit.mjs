// Read-only account and routing audit. Does not start jobs or write files.
import {readFileSync,readdirSync,statSync} from 'node:fs';
const env={};
for(const f of ['/opt/yemot/main.env','/opt/yemot/ext2.env']) for(const line of readFileSync(f,'utf8').split('\n')){
 const m=line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)$/); if(m && !(m[1] in env)) env[m[1]]=m[2].replace(/^["']|["']$/g,'');
}
async function get(url,headers={}){const r=await fetch(url,{headers,signal:AbortSignal.timeout(20000)});let j;try{j=await r.json()}catch{j={}}return {status:r.status,j};}
const token=env.YEMOT_TOKEN || (env.YEMOT_API_USERNAME+':'+env.YEMOT_API_PASSWORD);
async function ym(method,params={}){return (await get('https://www.call2all.co.il/ym/api/'+method+'?'+new URLSearchParams({token,...params}))).j;}
for(const n of [1,2,3,4,5,7]){
 const j=await ym('GetTextFile',{what:'ivr2:/'+n+'/ext.ini'});
 const cfg=Object.fromEntries(String(j.contents||'').split(/\r?\n/).map(l=>l.split(/=(.*)/s).slice(0,2)).filter(a=>a.length===2));
 let link=null; try{const u=new URL(cfg.api_link);link=u.origin+u.pathname}catch{}
 console.log('ROUTE',n,JSON.stringify({status:j.responseStatus,type:cfg.type,target:cfg.go_to_folder,link}));
}
const account=await ym('GetSession');console.log('YEMOT',JSON.stringify({status:account.responseStatus,units:account.units}));
for(const k of Object.keys(env).filter(k=>/^APIFY_TOKEN/.test(k))){
 const {status,j}=await get('https://api.apify.com/v2/users/me/limits',{Authorization:'Bearer '+env[k]});
 console.log('APIFY',k,JSON.stringify({status,current:j.data?.current,limits:j.data?.limits}));
}
const dg=Object.keys(env).find(k=>/^DEEPGRAM.*KEY/.test(k));
if(dg){
 const {status,j}=await get('https://api.deepgram.com/v1/projects',{Authorization:'Token '+env[dg]});
 console.log('DEEPGRAM projects',status,'count',j.projects?.length??null);
 for(const p of (j.projects||[])){
  const r=await get('https://api.deepgram.com/v1/projects/'+p.project_id+'/balances',{Authorization:'Token '+env[dg]});
  console.log('DEEPGRAM balance',JSON.stringify({status:r.status,balances:r.j.balances?.map(b=>({amount:b.amount,units:b.units}))}));
 }
}else console.log('DEEPGRAM key not found');
for(const dir of ['/opt/yemot','/var/backups','/etc/netplan']){
 try{console.log('BACKUP/NETWORK files',dir,JSON.stringify(readdirSync(dir).filter(n=>/backup|bak|netplan|yaml|yml/i.test(n)).map(n=>({file:n,modified:statSync(dir+'/'+n).mtime.toISOString()}))))}catch{console.log('UNAVAILABLE',dir)}
}
console.log('READ_ONLY_AUDIT_DONE');
