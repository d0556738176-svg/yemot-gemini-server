import { readSinglePublicWebsitePage, isPublicHttpUrl } from './website-reader.js';
import { selectWebsiteResult } from './website-selection.js';

const pageReference=/(?:הדף|העמוד|האתר|הדפים|העמודים).{0,30}(?:שפתחת|שנפתח|הזה|הנוכחי|הראשון|הראשונים)|(?:מה\s+שכתוב|מה\s+כתוב).{0,12}(?:שם|שמה)|מההתחלה|מהתחלה|על ההתחלה|בהתחלה/u;
const restartAction=/מההתחלה|מהתחלה|על ההתחלה|בהתחלה|תחזור|חזור|(?:הדפים|העמודים|הדף|העמוד)\s+(?:הראשונים|הראשונות|הראשון)/u;
const knownName=/^(?:הידברות|הדברות|hidabroot)(?:\s|$)/iu;
const uncertainName=/^(?:התאבות|התברות|התדברות)(?:\s|$)/u;

function extractedPageLinks(page) {
  const result=[...(page.links||[])];
  for(const m of String(page.content||'').matchAll(/\[([^\]]{2,180})\]\(([^)\s]+)\)/gu)) {
    try {
      const url=new URL(m[2],page.url);
      if(isPublicHttpUrl(url.href)&&url.origin===new URL(page.url).origin)result.push({url:url.href,content:m[1]});
    }catch{}
  }
  return [...new Map(result.map(link=>[link.url,link])).values()].slice(0,100);
}

export function isBranch1WebsiteRequest(q, context={}) {
  if(context.websiteClarification&&/^(?:כן|נכון|בדיוק|לא)(?:\s|[,.!?]|$)/u.test(q))return true;
  const concreteReference=/(?:הדף|העמוד|האתר|הדפים|העמודים)|(?:מה\s+שכתוב|מה\s+כתוב).{0,12}(?:שם|שמה)/u.test(q);
  if((context.currentWebsitePages?.length||context.pendingWebsiteUrl)&&pageReference.test(q)&&(context.lastRoute==='website'||concreteReference))return true;
  if(context.currentWebsitePages?.length&&context.lastRoute==='website'&&/מאיזה מקור|מה המקור|איזה אתר פתחת/u.test(q))return true;
  if(context.pendingWebsiteUrl&&/נסה שוב|תנסה שוב|עוד פעם/u.test(q))return true;
  // A page is open: questions about its links stay with it even after other
  // turns (the caller asked about the weather in between, or a turn was mis-heard).
  if(context.currentWebsitePages?.length&&/(?:איזה|אילו|תגיד|תקריא|יש)\s*(?:\S+\s+)?(?:קישורים|כישורים)|(?:קישור|כישור)\s*(?:מספר\s*)?(?:\d{1,2}|אחד|אחת|ראשון|שני|שלישי|רביעי|חמישי)|(?:בעמוד|בדף|באתר)\s+(?:הזה|שפתחת|שנפתח)/u.test(q))return true;
  return /https?:\/\/\S+|(?:פתח|תפתח|תיכנס|תכנס|לפתוח|להיכנס).{0,35}(?:אתר|דף|עמוד)|(?:תקרא|תקריא|קרא).{0,25}(?:באתר|מה שכתוב|מה כתוב)/u.test(q) ||
    !!context.currentWebsitePages?.length && (context.lastRoute==='website'||/חזור לאתר|תחזור לאתר/u.test(q)) && /^(?:כן[, ]*)?(?:תמשיך|המשך|תקרא|תקריא|קרא|מה כתוב|מה ראית|מה יש|תחזור|חזור|עוד|הלאה|דף|עמוד|פתח|תפתח|איזה קישורים|אילו קישורים|תפריט|תעבור)/u.test(q);
}

export function requestedSiteName(q) {
  if(!/(?:האתר|אתר)\s+/u.test(q))return '';
  const name=String(q||'').replace(/^.*?(?:האתר|אתר)\s*(?:של\s+)?/u,'')
    .split(/\s+(?:ו?(?:תקרא|תקריא|קרא|הקרא|תקע)|ותגיד|ואז|וקרא)(?:\s|$)/u)[0]
    .replace(/[.,!?]/gu,' ').trim();
  return /^(?:הזה|זה|שפתחת|שנפתח|הנוכחי)(?:\s|$)/u.test(name)?'':name;
}

// Page text is read aloud: drop image/link paths, markdown image markers and
// framework image URLs that readers leave in, so only real words are spoken.
export function speakablePageText(text) {
  return String(text||'')
    .replace(/!\[[^\]]*\]\([^)]*\)/gu,' ')
    .replace(/\[([^\]]+)\]\((?:https?:\/\/|\/)[^)]*\)/gu,'$1')
    .replace(/\((?:https?:\/\/|\/)[^)\s]*(?:\s[^)]*)?\)/gu,' ')
    .replace(/(?:https?:\/\/|\/_?next\/|\/api\/media\/)\S+/gu,' ')
    .replace(/(?:^|\s)!(?=\s|$)/gu,' ')
    .replace(/\s+/gu,' ').trim();
}

export function websiteChunk(context, restart=false, maxChars=850) {
  const page=context.currentWebsitePages?.[context.currentWebsitePageIndex||0];
  if(!page?.content)return null;
  if(!page.speakable){page.content=speakablePageText(page.content);page.speakable=true;}
  const offset=restart?0:Number(context.currentWebsiteReadOffset||0);
  if(offset>=page.content.length)return 'זה סוף הטקסט שנקרא מהעמוד. אפשר לבקש את רשימת הקישורים או לפתוח כתבה מסוימת.';
  let end=Math.min(page.content.length,offset+maxChars);
  if(end<page.content.length){const space=page.content.lastIndexOf(' ',end);if(space>offset+maxChars/2)end=space;}
  context.currentWebsiteReadOffset=end;
  return (offset===0?'מתוך '+(page.title||'העמוד שביקשת')+': ':'המשך: ')+page.content.slice(offset,end).trim()+
    (end<page.content.length?' להמשך אפשר לומר תמשיך.':' זה סוף הטקסט הזמין בעמוד.');
}

export async function answerBranch1Website(q,context,{search,read=readSinglePublicWebsitePage,extract,official=null,logger=console}={}) {
  const pages=context.currentWebsitePages||[];
  const current=pages[context.currentWebsitePageIndex||0];
  const site=requestedSiteName(q);
  const fresh=/https?:\/\//u.test(q)||!!site;
  if(context.websiteClarification&&!fresh) {
    if(/^(?:כן|נכון|בדיוק)(?:\s|[,.!?]|$)/u.test(q)){const url=context.websiteClarification.url;context.websiteClarification=null;return load(url);}
    if(/^לא(?:\s|[,.!?]|$)/u.test(q)){context.websiteClarification=null;return 'מה שם האתר שהתכוונת לפתוח?';}
  }
  if(context.pendingWebsiteUrl&&!fresh&&!context.websiteClarification)return load(context.pendingWebsiteUrl);
  if(current&&!fresh) {
    if(/מאיזה מקור|מה המקור|כתובת (?:האתר|הדף)|איזה אתר פתחת/u.test(q))return 'העמוד הפתוח הוא '+(current.title||new URL(current.url).hostname)+'. הכתובת היא '+current.url+'.';
    if(/(?:איזה|אילו)\s*(?:\S+\s+)?(?:קישורים|כישורים)|תפריט|רשימת (?:קישורים|כתבות)/u.test(q)) {
      const links=(current.links||[]).filter(l=>l.content?.length>3).slice(0,8);
      context.currentWebsiteChoices=links;
      return links.length?'הקישורים בעמוד: '+links.map((l,i)=>(i+1)+'. '+l.content).join('. ')+'. אפשר לומר פתח קישור ואת המספר.':'לא נמצאו קישורים קריאים בעמוד הזה.';
    }
    const number=q.match(/(?:קישור|כישור|כתבה|עמוד|דף|פתח(?:\s+את)?)\s*(?:מספר\s*)?(\d{1,2}|אחד|אחת|הראשון|ראשון|שתיים|שניים|השני|שני|שלוש|השלישי|שלישי|ארבע|הרביעי|רביעי|חמש|החמישי|חמישי|שש|שבע|שמונה)(?:\s|[,.!?]|$)/u);
    const ordinals={'אחד':1,'אחת':1,'הראשון':1,'ראשון':1,'שתיים':2,'שניים':2,'השני':2,'שני':2,'שלוש':3,'השלישי':3,'שלישי':3,'ארבע':4,'הרביעי':4,'רביעי':4,'חמש':5,'החמישי':5,'חמישי':5,'שש':6,'שבע':7,'שמונה':8};
    const chosenNumber=number?(Number(number[1])||ordinals[number[1]]):null;
    let link=number ? context.currentWebsiteChoices?.[chosenNumber-1] : null;
    const navigation=/(?:פתח|תפתח|תעבור|עבור|תיכנס)/u.test(q)&&!pageReference.test(q);
    if(!link&&navigation) {
      const words=q.split(/\s+/u).filter(w=>w.length>2&&!/^(?:תפתח|תעבור|תיכנס|הכתבה|כתבה|עמוד|קישור|העמוד|לי|את)$/u.test(w));
      const ranked=(current.links||[]).map(l=>({link:l,score:words.filter(w=>l.content.includes(w)).length})).sort((a,b)=>b.score-a.score);
      if(ranked[0]?.score>0&&(!ranked[1]||ranked[0].score>ranked[1].score))link=ranked[0].link;
    }
    if(link)return load(link.url);
    if(number&&!restartAction.test(q) || navigation)return 'לא זיהיתי בוודאות את הקישור שביקשת. אפשר לומר איזה קישורים יש, ואז לבחור מספר.';
    if(pageReference.test(q)||/תמשיך|המשך|עוד|הלאה|תקרא|תקריא|קרא|מה כתוב|מה ראית|מה יש|תחזור|חזור/u.test(q)) {
      context.lastRoute='website';
      const restart=restartAction.test(q)||pageReference.test(q)&&!/(תמשיך|המשך|עוד|הלאה)/u.test(q);
      logger.info('[BRANCH1 WEBSITE] cached reading',{action:restart?'restart':'continue',host:new URL(current.url).hostname,offset:restart?0:context.currentWebsiteReadOffset||0});
      return websiteChunk(context,restart);
    }
  }
  const explicit=q.match(/https?:\/\/[^\s<>]+/u)?.[0];
  // This verified public hostname is a site identity, never cached page content.
  let url=explicit || (knownName.test(site)?'https://www.hidabroot.org/':null);
  if(!url&&uncertainName.test(site)) {
    if(current&&new URL(current.url).hostname.replace(/^www\./,'')==='hidabroot.org')url='https://www.hidabroot.org/';
    else {context.websiteClarification={url:'https://www.hidabroot.org/'};context.lastRoute='website';return 'התכוונת לאתר הידברות?';}
  }
  if(!url&&!site&&context.pendingWebsiteUrl)return load(context.pendingWebsiteUrl);
  if(!url&&!site)return 'איזה אתר לפתוח ולקרוא? אפשר לומר את שמו או את כתובתו.';
  if(!url&&official&&!/(?:כתבה|מאמר|עמוד על|דף של)/u.test(q)) {
    const found=await official(site).catch(e=>{logger.warn('[BRANCH1 WEBSITE] official site lookup failed',{status:e?.status||0});return null;});
    if(found?.url){url=new URL(found.url).origin+'/';logger.info('[BRANCH1 WEBSITE] official site from knowledge panel',{host:new URL(url).hostname});}
  }
  if(!url) {
    const results=await search(site+' אתר רשמי',{timeoutMs:2200});
    const selected=selectWebsiteResult('פתח אתר '+site,results);
    if(!selected)return 'לא הצלחתי לזהות בוודאות את האתר שביקשת. אמור את שם האתר או את כתובתו.';
    const parsed=new URL(selected.url);
    // A request for a site opens its homepage; a request for a named article
    // may select a deeper URL. Never let search ranking choose an arbitrary story.
    url=/(?:כתבה|מאמר|עמוד על|דף של)/u.test(q)?parsed.href:parsed.origin+'/';
  }
  context.websiteClarification=null;
  const canonical=value=>{const u=new URL(value);return u.hostname.replace(/^www\./,'')+u.pathname.replace(/\/$/,'')+u.search;};
  if(current&&canonical(url)===canonical(current.url)&&!/(רענן|תעדכן|עדכן|טען מחדש)/u.test(q)) {
    context.lastRoute='website';
    logger.info('[BRANCH1 WEBSITE] same page reused',{host:new URL(current.url).hostname,chars:current.content.length});
    return websiteChunk(context,true);
  }
  return load(url);

  async function load(target) {
    if(!isPublicHttpUrl(target))return 'הכתובת אינה כתובת ציבורית תקינה של אתר לקריאה.';
    context.pendingWebsiteUrl=target;context.lastRoute='website';
    let page,source='direct';
    try{page=await read({url:target,timeoutMs:2500});}catch{}
    if(!page&&extract){try{page=await extract(target,2500);source='extract';}catch{}}
    if(!page?.content||page.content.length<80)return 'לא הצלחתי לקרוא כרגע את תוכן העמוד שביקשת. אפשר לומר נסה שוב ואנסה את אותו אתר, בלי להחליף אותו באתר אחר.';
    const expected=new URL(target),actual=new URL(page.url||target);
    if(expected.hostname.replace(/^www\./,'')!==actual.hostname.replace(/^www\./,''))return 'הכתובת הפנתה לאתר אחר ולכן לא אציג אותו כאילו הוא האתר שביקשת.';
    context.currentWebsiteUrl=page.url||target;context.pendingWebsiteUrl=null;
    context.lastRoute='website';
    context.currentWebsitePages=[{...page,url:page.url||target,title:page.title||actual.hostname,links:extractedPageLinks({...page,url:page.url||target})}];
    context.currentWebsitePageIndex=0;context.currentWebsiteReadOffset=0;context.currentWebsiteChoices=[];
    logger.info('[BRANCH1 WEBSITE] page ready',{host:actual.hostname,path:actual.pathname,source,chars:page.content.length,links:page.links?.length||0});
    return websiteChunk(context,true);
  }
}
