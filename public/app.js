const $=id=>document.getElementById(id);
$('token').value=sessionStorage.getItem('dashToken')||'';
$('save').onclick=()=>{sessionStorage.setItem('dashToken',$('token').value);load();};
$('refresh').onclick=load;
function headers(extra={}){return {'Authorization':'Bearer '+$('token').value,...extra};}
function esc(s){return String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));}
let youtubeItems=new Map();

async function load(){
 $('status').textContent='טוען...';
 try{
  const h=await fetch('/health',{cache:'no-store'});
  $('health').textContent=JSON.stringify(await h.json(),null,2);
  const r=await fetch('/api/conversations',{headers:headers(),cache:'no-store'});
  if(!r.ok) throw new Error('Dashboard API '+r.status);
  const d=await r.json();
  $('active').innerHTML=d.activeCalls.length?d.activeCalls.map(x=>'<div class="item"><b>'+esc(x.phone)+'</b> — '+esc(x.status)+'</div>').join(''):'אין שיחות פעילות';
  $('calls').innerHTML=d.conversations.slice().reverse().map(x=>'<div class="item"><b>'+esc(x.phone)+'</b><div>'+esc(x.user)+'</div><div class="muted">'+esc(x.gemini)+'</div></div>').join('')||'אין שיחות';
  $('status').textContent='מחובר';
 }catch(e){$('status').textContent='נדרשת התחברות';$('calls').textContent=e.message}
}

$('yt').onclick=async()=>{
 const q=$('ytq').value.trim(); if(!q)return;
 $('ytresults').textContent='מחפש...';
 try{
  const r=await fetch('/api/youtube/search?q='+encodeURIComponent(q),{headers:headers(),cache:'no-store'});
  const d=await r.json();
  if(!r.ok) throw new Error(d.error||('שגיאה '+r.status));
  youtubeItems=new Map((d.items||[]).map(x=>[x.videoId,x]));
  if(!youtubeItems.size){$('ytresults').textContent='לא נמצאו תוצאות.';return;}
  $('ytresults').innerHTML=[...youtubeItems.values()].map(x=>'<div class="item"><div class="yt">'+(x.thumbnail?'<img src="'+esc(x.thumbnail)+'" alt="">':'')+'<div><b>'+esc(x.title)+'</b><div class="muted">'+esc(x.channelTitle)+'</div><div class="muted">מזהה: '+esc(x.videoId)+'</div><button data-action="choose" data-id="'+esc(x.videoId)+'">בחר וחבר מקור שמע</button> <button class="secondary" data-action="preview" data-id="'+esc(x.videoId)+'">הצג תצוגה</button></div></div></div>').join('');
 }catch(e){$('ytresults').textContent=e.message||'חיפוש YouTube נכשל.'}
};

$('ytresults').addEventListener('click',event=>{
 const button=event.target.closest('button[data-action]');
 if(!button)return;
 const id=button.dataset.id;
 if(button.dataset.action==='choose') selectVideo(id);
 if(button.dataset.action==='preview') previewVideo(id);
});

function selectVideo(id){
 const video=youtubeItems.get(id);
 if(!video)return;
 $('sourceVideoId').value=id;
 $('selectedVideo').textContent='נבחר: '+video.title+' — '+video.channelTitle;
 $('sourceStatus').textContent='הזן מקור שמע ישיר בכתובת HTTPS וסמן את אישור הזכויות.';
 $('sourceUrl').focus();
}

function previewVideo(id){
 if(!youtubeItems.has(id))return;
 const box=document.createElement('div');
 box.className='item';
 const frame=document.createElement('iframe');
 frame.src='https://www.youtube-nocookie.com/embed/'+encodeURIComponent(id);
 frame.title='YouTube preview';
 frame.allow='accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture';
 frame.allowFullscreen=true;
 box.appendChild(frame);
 $('ytresults').prepend(box);
}

$('registerSource').onclick=async()=>{
 const videoId=$('sourceVideoId').value.trim();
 const sourceUrl=$('sourceUrl').value.trim();
 if(!videoId){$('sourceStatus').textContent='בחר תחילה סרטון מתוך תוצאות החיפוש.';return;}
 if(!$('rightsConfirmed').checked){$('sourceStatus').textContent='יש לסמן את אישור הזכויות לפני שמירת המקור.';return;}
 let parsed;
 try{parsed=new URL(sourceUrl);if(parsed.protocol!=='https:')throw new Error();}
 catch{$('sourceStatus').textContent='הזן כתובת מלאה שמתחילה ב־https://.';return;}
 $('registerSource').disabled=true;
 $('sourceStatus').textContent='שומר מיפוי...';
 try{
  const r=await fetch('/api/youtube/authorized-source',{
   method:'POST',headers:headers({'Content-Type':'application/json'}),
   body:JSON.stringify({videoId,sourceUrl:parsed.toString(),rightsConfirmed:true})
  });
  const d=await r.json();
  if(!r.ok)throw new Error(d.error||('שגיאה '+r.status));
  $('sourceStatus').textContent='המיפוי נשמר בהצלחה עבור מזהה '+videoId+'. עכשיו אפשר לבחור את הסרטון בשלוחה 2 ולענות ״כן״.';
 }catch(e){$('sourceStatus').textContent='לא נשמר: '+(e.message||'שגיאה לא ידועה');}
 finally{$('registerSource').disabled=false;}
};

$('checkSource').onclick=async()=>{
 const videoId=$('sourceVideoId').value.trim();
 if(!videoId){$('sourceStatus').textContent='בחר תחילה סרטון.';return;}
 try{
  const r=await fetch('/api/youtube/authorized-source?videoId='+encodeURIComponent(videoId),{headers:headers(),cache:'no-store'});
  const d=await r.json();
  if(!r.ok)throw new Error(d.error||('שגיאה '+r.status));
  if(!d.source||!d.source.enabled){$('sourceStatus').textContent='לא נמצא מקור שמע פעיל לסרטון הזה.';return;}
  let host='כתובת שמורה';
  try{host=new URL(d.source.source_url).hostname;}catch{}
  $('sourceStatus').textContent='נמצא מיפוי פעיל עבור '+videoId+'. שרת המקור: '+host+'.';
 }catch(e){$('sourceStatus').textContent='לא ניתן לבדוק מיפוי: '+(e.message||'שגיאה לא ידועה');}
};

$('removeSource').onclick=async()=>{
 const videoId=$('sourceVideoId').value.trim();
 if(!videoId){$('sourceStatus').textContent='בחר תחילה סרטון.';return;}
 if(!window.confirm('להסיר את מיפוי מקור השמע עבור '+videoId+'?'))return;
 try{
  const r=await fetch('/api/youtube/authorized-source?videoId='+encodeURIComponent(videoId),{method:'DELETE',headers:headers(),cache:'no-store'});
  const d=await r.json();
  if(!r.ok)throw new Error(d.error||('שגיאה '+r.status));
  $('sourceStatus').textContent='מיפוי מקור השמע הוסר.';
 }catch(e){$('sourceStatus').textContent='הסרה נכשלה: '+(e.message||'שגיאה לא ידועה');}
};

load();
