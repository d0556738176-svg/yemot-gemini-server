const TIMEOUT_MS=Number(process.env.YOUTUBE_ALTERNATE_AUDIO_TIMEOUT_MS||4500);

function clean(value) {
  return String(value||'').normalize('NFKC').toLowerCase()
    .replace(/&(?:amp|quot|apos);/g,' ')
    .replace(/[^\p{L}\p{N}\s]/gu,' ')
    .replace(/\s+/g,' ').trim();
}
function words(value) {
  const stop=new Set(['the','a','an','and','or','של','את','עם','על','זה','הזה','פרק','episode','official','video']);
  return clean(value).split(' ').filter(x=>x.length>1&&!stop.has(x));
}
function scoreTitle(wanted,candidate) {
  const a=words(wanted), b=new Set(words(candidate));
  if(!a.length) return 0;
  return a.filter(x=>b.has(x)).length/a.length;
}
function decodeXml(value) {
  return String(value||'').replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g,'$1')
    .replace(/&amp;/g,'&').replace(/&quot;/g,'"').replace(/&#39;|&apos;/g,"'");
}
function tag(block,name) {
  const m=block.match(new RegExp('<'+name+'(?:\\s[^>]*)?>([\\s\\S]*?)<\\/'+name+'>','i'));
  return decodeXml(m?.[1]||'').replace(/<[^>]+>/g,' ').replace(/\s+/g,' ').trim();
}
function enclosure(block) {
  const m=block.match(/<enclosure\b[^>]*\burl=(["'])(.*?)\1[^>]*>/i);
  return decodeXml(m?.[2]||'').trim();
}

export async function resolvePublisherAudio(video) {
  const title=String(video?.title||'').trim();
  const channel=String(video?.channelTitle||'').trim();
  if(!title) return null;

  // Apple search is used only to discover the publisher's public podcast RSS.
  // Playback comes from the publisher's RSS enclosure URL, not an Apple preview.
  const q=[title,channel].filter(Boolean).join(' ').slice(0,180);
  const url=new URL('https://itunes.apple.com/search');
  url.searchParams.set('term',q);
  url.searchParams.set('media','podcast');
  url.searchParams.set('entity','podcast');
  url.searchParams.set('limit','8');
  url.searchParams.set('country','IL');

  const response=await fetch(url,{headers:{accept:'application/json'},signal:AbortSignal.timeout(TIMEOUT_MS)});
  if(!response.ok) return null;
  const data=await response.json().catch(()=>null);
  const feeds=(data?.results||[]).map(x=>x.feedUrl).filter(Boolean).slice(0,8);

  let best=null;
  await Promise.allSettled(feeds.map(async feedUrl=>{
    const r=await fetch(feedUrl,{headers:{accept:'application/rss+xml,application/xml,text/xml'},signal:AbortSignal.timeout(TIMEOUT_MS),redirect:'follow'});
    if(!r.ok) return;
    const xml=(await r.text()).slice(0,2500000);
    const items=xml.split(/<item\b[^>]*>/i).slice(1,80);
    for(const item of items) {
      const candidateTitle=tag(item,'title');
      const mediaUrl=enclosure(item);
      if(!candidateTitle||!mediaUrl) continue;
      const score=scoreTitle(title,candidateTitle);
      if(score>=0.68&&(!best||score>best.score)) best={url:mediaUrl,title:candidateTitle,score,source:'publisher-rss'};
    }
  }));
  return best;
}
