const $=id=>document.getElementById(id);
$('token').value=sessionStorage.getItem('dashToken')||'';
$('save').onclick=()=>{sessionStorage.setItem('dashToken',$('token').value);load();};
$('refresh').onclick=load;
function headers(){return {'Authorization':'Bearer '+$('token').value};}
async function load(){
 $('status').textContent='טוען...';
 try{
  const h=await fetch('/health',{cache:'no-store'}); $('health').textContent=JSON.stringify(await h.json(),null,2);
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
 const r=await fetch('/api/youtube/search?q='+encodeURIComponent(q),{headers:headers()});
 const d=await r.json(); if(!r.ok){$('ytresults').textContent=d.error||'שגיאה';return}
 $('ytresults').innerHTML=d.items.map(x=>'<div class="item"><div class="yt"><img src="'+esc(x.thumbnail)+'"><div><b>'+esc(x.title)+'</b><div class="muted">'+esc(x.channelTitle)+'</div><button onclick="play(\''+esc(x.videoId)+'\')">נגן</button></div></div></div>').join('');
}
function play(id){$('ytresults').insertAdjacentHTML('afterbegin','<div class="item"><iframe src="https://www.youtube-nocookie.com/embed/'+encodeURIComponent(id)+'" allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture" allowfullscreen></iframe></div>')}
function esc(s){return String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]))}
load();