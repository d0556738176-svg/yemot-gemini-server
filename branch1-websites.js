import { readSinglePublicWebsitePage, isPublicHttpUrl } from './website-reader.js';
import { selectWebsiteResult } from './website-selection.js';

export function isBranch1WebsiteRequest(q, context={}) {
  return /https?:\/\/\S+|(?:פתח|תפתח|תיכנס|תכנס|לפתוח|להיכנס).{0,35}(?:אתר|דף|עמוד)|(?:תקרא|תקריא|קרא).{0,25}(?:באתר|מה שכתוב|מה כתוב)/u.test(q) ||
    !!context.currentWebsitePages?.length && (context.lastRoute==='website'||/חזור לאתר|תחזור לאתר/u.test(q)) && /^(?:כן[, ]*)?(?:תמשיך|המשך|תקרא|תקריא|קרא|מה כתוב|מה ראית|מה יש|תחזור|חזור|עוד|הלאה|דף|עמוד|פתח|תפתח|איזה קישורים|אילו קישורים|תפריט|תעבור)/u.test(q);
}

export function requestedSiteName(q) {
  return String(q||'').replace(/^.*?(?:האתר|אתר)\s*(?:של\s+)?/u,'')
    .split(/\s+(?:ו?(?:תקרא|תקריא|קרא|הקרא|תקע)|ותגיד|ואז|וקרא)(?:\s|$)/u)[0]
    .replace(/[.,!?]/gu,' ').trim();
}

export function websiteChunk(context, restart=false, maxChars=650) {
  const page=context.currentWebsitePages?.[context.currentWebsitePageIndex||0];
  if(!page?.content)return null;
  const offset=restart?0:Number(context.currentWebsiteReadOffset||0);
  if(offset>=page.content.length)return 'זה סוף הטקסט שנקרא מהעמוד. אפשר לבקש את רשימת הקישורים או לפתוח כתבה מסוימת.';
  let end=Math.min(page.content.length,offset+maxChars);
  if(end<page.content.length){const space=page.content.lastIndexOf(' ',end);if(space>offset+maxChars/2)end=space;}
  context.currentWebsiteReadOffset=end;
  return (offset===0?'מתוך '+(page.title||'העמוד שביקשת')+': ':'המשך: ')+page.content.slice(offset,end).trim()+
    (end<page.content.length?' אפשר לומר תמשיך להמשך הקריאה.':' זה סוף הטקסט הזמין בעמוד.');
}

export async function answerBranch1Website(q,context,{search,read=readSinglePublicWebsitePage,extract}={}) {
  const pages=context.currentWebsitePages||[];
  const current=pages[context.currentWebsitePageIndex||0];
  const fresh=/https?:\/\/|(?:האתר|אתר)\s+(?!הזה|זה|שפתחת)\S+/u.test(q);
  if(current&&!fresh) {
    if(/איזה קישורים|אילו קישורים|תפריט|רשימת (?:קישורים|כתבות)/u.test(q)) {
      const links=(current.links||[]).filter(l=>l.content?.length>3).slice(0,8);
      context.currentWebsiteChoices=links;
      return links.length?'הקישורים בעמוד: '+links.map((l,i)=>(i+1)+'. '+l.content).join('. ')+'. אפשר לומר פתח קישור ואת המספר.':'לא נמצאו קישורים קריאים בעמוד הזה.';
    }
    const number=q.match(/(?:קישור|כתבה|עמוד|דף)\s*(?:מספר\s*)?(\d{1,2})/u);
    let link=number ? context.currentWebsiteChoices?.[Number(number[1])-1] : null;
    if(!link&&/(?:פתח|תפתח|תעבור|עבור|תיכנס)/u.test(q)) {
      const words=q.split(/\s+/u).filter(w=>w.length>2&&!/^(?:תפתח|תעבור|תיכנס|הכתבה|כתבה|עמוד|קישור|העמוד|לי|את)$/u.test(w));
      const ranked=(current.links||[]).map(l=>({link:l,score:words.filter(w=>l.content.includes(w)).length})).sort((a,b)=>b.score-a.score);
      if(ranked[0]?.score>0&&(!ranked[1]||ranked[0].score>ranked[1].score))link=ranked[0].link;
    }
    if(link)return load(link.url);
    if(number || /(?:פתח|תפתח|תעבור|עבור|תיכנס)/u.test(q))return 'לא זיהיתי בוודאות את הקישור שביקשת. אפשר לומר איזה קישורים יש, ואז לבחור מספר.';
    if(/תמשיך|המשך|עוד|הלאה|תקרא|תקריא|קרא|מה כתוב|מה ראית|מה יש|תחזור|חזור/u.test(q))return websiteChunk(context,/מההתחלה|תחזור|חזור/u.test(q));
  }
  const explicit=q.match(/https?:\/\/[^\s<>]+/u)?.[0];
  const site=requestedSiteName(q);
  // This verified public hostname is a site identity, never cached page content.
  let url=explicit || (/^(?:הידברות|הדברות|hidabroot)(?:\s|$)/iu.test(site)?'https://www.hidabroot.org/':null);
  if(!url) {
    const results=await search(site+' אתר רשמי',{timeoutMs:2200});
    const selected=selectWebsiteResult('פתח אתר '+site,results);
    if(!selected)return 'לא הצלחתי לזהות בוודאות את האתר שביקשת. אמור את שם האתר או את כתובתו.';
    const parsed=new URL(selected.url);
    // A request for a site opens its homepage; a request for a named article
    // may select a deeper URL. Never let search ranking choose an arbitrary story.
    url=/(?:כתבה|מאמר|עמוד על|דף של)/u.test(q)?parsed.href:parsed.origin+'/';
  }
  return load(url);

  async function load(target) {
    if(!isPublicHttpUrl(target))return 'הכתובת אינה כתובת ציבורית תקינה של אתר לקריאה.';
    let page;
    try{page=await read({url:target,timeoutMs:3000});}catch{}
    if(!page&&extract){try{page=await extract(target,2500);}catch{}}
    if(!page?.content||page.content.length<80)return 'לא הצלחתי לקרוא כרגע את תוכן העמוד שביקשת. האתר לא החזיר טקסט קריא בזמן הבדיקה. לא אחליף אותו בכתבה אחרת.';
    const expected=new URL(target),actual=new URL(page.url||target);
    if(expected.hostname.replace(/^www\./,'')!==actual.hostname.replace(/^www\./,''))return 'הכתובת הפנתה לאתר אחר ולכן לא אציג אותו כאילו הוא האתר שביקשת.';
    context.currentWebsiteUrl=page.url||target;
    context.lastRoute='website';
    context.currentWebsitePages=[{...page,url:page.url||target,links:page.links||[]}];
    context.currentWebsitePageIndex=0;context.currentWebsiteReadOffset=0;context.currentWebsiteChoices=[];
    return websiteChunk(context,true);
  }
}
