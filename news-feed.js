// Google News' public RSS feed in Hebrew for Israel (no key, no quota).
export { rssText };
function rssText(x){ return String(x||'').replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g,'$1').replace(/<[^>]+>/g,' ').replace(/&quot;/g,'"').replace(/&#39;|&apos;/g,"'").replace(/&amp;/g,'&').replace(/&lt;/g,'<').replace(/&gt;/g,'>').replace(/&nbsp;/g,' ').replace(/\s+/g,' ').trim(); }
export async function googleNewsRss(query,{timeoutMs=4000,fetchImpl=fetch}={}) {
  const u=query?'https://news.google.com/rss/search?'+new URLSearchParams({q:query+' when:1d',hl:'he',gl:'IL',ceid:'IL:he'}):'https://news.google.com/rss?hl=he&gl=IL&ceid=IL:he';
  const r=await fetchImpl(u,{signal:AbortSignal.timeout(timeoutMs),headers:{'user-agent':'Mozilla/5.0 (compatible; YemotNews/1.0)','accept-language':'he'}});
  if(!r.ok) throw Object.assign(new Error('Google News RSS HTTP '+r.status),{status:r.status});
  const xml=await r.text();
  const items=[];
  for(const m of xml.matchAll(/<item>([\s\S]*?)<\/item>/g)) {
    const b=m[1], tag=t=>((b.match(new RegExp('<'+t+'[^>]*>([\\s\\S]*?)<\\/'+t+'>'))||[])[1]||'');
    let title=rssText(tag('title')); const source=rssText(tag('source'));
    if(source&&title.endsWith(' - '+source)) title=title.slice(0,-(source.length+3)).trim();
    const when=Date.parse(rssText(tag('pubDate')));
    if(title) items.push({title,snippet:'',source,date:Number.isFinite(when)?new Date(when).toLocaleString('he-IL',{timeZone:'Asia/Jerusalem',hour:'2-digit',minute:'2-digit',day:'numeric',month:'numeric'}):'',url:rssText(tag('link')),at:Number.isFinite(when)?when:0});
  }
  return items.sort((a,b)=>b.at-a.at).slice(0,15);
}
