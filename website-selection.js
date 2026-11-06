/**
 * Select a search result for an explicit website-opening request.
 * A result is accepted only when a meaningful requested-site token appears
 * in its title or URL. Never fall back to the first unrelated search result.
 */
export function selectWebsiteResult(question, results) {
  const requestedSite=String(question||'')
    .replace(/^(?:אז\s*)?(?:תפתח|פתח|תיכנס|תכנס|תחפש|חפש)\s+(?:לי\s+)?(?:את\s+)?(?:האתר|אתר)\s+(?:של\s+)?/i,'')
    .replace(/^(?:אז\s*)?(?:תפתח|פתח)\s+(?:לי\s+)?את\s+/i,'')
    .replace(/^(?:את\s+)?(?:האתר|אתר)\s+(?:של\s+)?/i,'')
    .replace(/\s+(?:ותקרא|תקרא|ותגיד|תגיד).*[\s\S]*$/i,'')
    .replace(/[.,!?;:"׳״'()]/g,' ')
    .trim().toLowerCase();
  const tokens=requestedSite.split(/\s+/).filter(token=>token.length>2);
  if(!tokens.length || !Array.isArray(results) || !results.length) return null;

  const scored=results.map((item,index)=>{
    const haystack=(String(item?.title||'')+' '+String(item?.url||'')).toLowerCase();
    const matchedTokens=tokens.filter(token=>haystack.includes(token));
    let score=matchedTokens.length*2+(index===0?0.1:0);
    try {
      const parsed=new URL(item.url);
      // "Open the X website" means X's own site. A homepage outranks a deep page
      // on a directory or review site that merely mentions X in its title.
      const depth=parsed.pathname.split('/').filter(Boolean).length;
      if(matchedTokens.length) score+=depth===0?1.5:depth===1?0.5:-0.5;
      if(parsed.protocol!=='https:' && parsed.protocol!=='http:') {
        return {item,score:-Infinity,index,matchedTokens:[]};
      }
    } catch { return {item,score:-Infinity,index,matchedTokens:[]}; }
    return {item,score,index,matchedTokens};
  }).sort((a,b)=>b.score-a.score || a.index-b.index);
  const best=scored[0];
  return best && best.matchedTokens.length>0 && best.score>0 ? best.item : null;
}
