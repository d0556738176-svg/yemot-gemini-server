// Explicit owner-requested live verification: one short public sample, free downloader only.
import {readFileSync} from 'node:fs';
for(const l of readFileSync('/opt/yemot/ext2.env','utf8').split('\n')){
 const m=l.match(/^([A-Z0-9_]+)="(.*)"$/);if(m)process.env[m[1]]=m[2];
}
process.env.BRANCH2_EXT7='off';
process.env.BRANCH2_DOWNLOAD_COPY='off';
process.env.BRANCH2_COVER_ART='off';
const {downloadAuthorizedAudioToYemot,_pipeline:p}=await import('/opt/yemot/ext2/youtube-authorized-playback.js');
const {registerWebItem}=await import('/opt/yemot/ext2/web-items.js');
const token=p.yemotApiKey();
async function ini(n){
 const r=await fetch(p.YEMOT_API_BASE+'/GetTextFile',{method:'POST',body:new URLSearchParams({token,what:'ivr2:/'+n+'/ext.ini'}),signal:AbortSignal.timeout(20000)});
 const j=await r.json();if(j.responseStatus!=='OK')throw Error('Cannot inspect extension '+n);
 return j.contents;
}
const other=[1,2,3,4,7], before=await Promise.all(other.map(ini));
if(!/ext5_web_audio_library=yes/.test(await ini(5)))throw Error('Extension 5 not configured');
const id=registerWebItem({url:'https://www.w3schools.com/html/mov_bbb.mp4',title:'בדיקת שמע קצרה — קובץ ציבורי',site:'w3schools.com',hasVideo:true,hasAudio:true});
console.log('EXT5_TEST_START',id);
const result=await downloadAuthorizedAudioToYemot(id,{signal:AbortSignal.timeout(180000),onProgress:x=>console.log('STAGE',x.stage)});
console.log('PHONE_AUDIO_READY',result.chunkCount);
let entry;
for(let n=0;n<65;n++){
 const idx=await p.readCacheJson('ivr2:/2/youtubeaudio/ext5_index.json');
 entry=idx?.items?.[id];if(entry)break;
 await new Promise(r=>setTimeout(r,2000));
}
if(!entry)throw Error('No extension 5 completion receipt');
const file=await p.getYemotFile('ivr2:/5/'+entry.file+'.wav');
if(file?.responseStatus!=='OK'||!file.file?.exists||!Number(file.file?.size))throw Error('Extension 5 file not ready');
const after=await Promise.all(other.map(ini));
if(after.some((x,i)=>x!==before[i]))throw Error('Another extension configuration changed during verification');
console.log('EXT5_END_TO_END_OK',JSON.stringify({id,file:entry.file,size:file.file.size,duration:file.file.duration,otherExtensionsUnchanged:true}));
