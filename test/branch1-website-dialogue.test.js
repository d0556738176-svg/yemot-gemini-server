import test from 'node:test';
import assert from 'node:assert/strict';
import {answerBranch1Website,isBranch1WebsiteRequest} from '../branch1-websites.js';
import {resolveBranch1Question} from '../branch1-reliability.js';
import {readSinglePublicWebsitePage} from '../website-reader.js';

const quiet={info(){}};
const content='תחילת התוכן המקורי של הדף. '+('תוכן נוסף מתוך האתר. '.repeat(100));
const deps=(counter={count:0})=>({logger:quiet,search:()=>{throw Error('No extra search expected');},read:async({url})=>{counter.count++;return {url,title:'הידברות',content,links:[]};}});

test('exact caller correction overrides wrong site and reads from beginning without repeating fetches',async()=>{
  const context={};const counter={count:0};const services=deps(counter);
  const mistaken=await answerBranch1Website('תפתח לי את אתר התאבות ותקרא לי את הדפים הראשונים',context,services);
  assert.match(mistaken,/התכוונת לאתר הידברות/);assert.equal(counter.count,0);
  let answer=await answerBranch1Website('לא, ביקשתי שתפתח את אתר הידברות ותקרא את מה שכתוב שם על ההתחלה',context,services);
  assert.match(answer,/תחילת התוכן המקורי/);assert.equal(counter.count,1);
  assert.equal(isBranch1WebsiteRequest('את הדף שנפתח לך, שפתחת',context),true);
  answer=await answerBranch1Website('את הדף שנפתח לך, שפתחת',context,services);
  assert.match(answer,/תחילת התוכן המקורי/);
  const initialOffset=context.currentWebsiteReadOffset;
  await answerBranch1Website('תמשיך',context,services);assert.ok(context.currentWebsiteReadOffset>initialOffset);
  answer=await answerBranch1Website('ותקרא את מה שכתוב שם על ההתחלה',context,services);
  assert.match(answer,/תחילת התוכן המקורי/);assert.equal(context.currentWebsiteReadOffset,initialOffset);
  await answerBranch1Website('פתח את אתר הידברות וקרא מההתחלה',context,services);assert.equal(counter.count,1);
});

test('explicit website name survives generic correction processing',()=>{
  const q='לא הבנת. פתח את אתר הידברות ותקרא על ההתחלה';
  assert.equal(resolveBranch1Question(q,[{user:'פתח אתר אחר'}]),q);
});

test('short yes after site clarification opens only the proposed site',async()=>{
  const context={};const services=deps();
  await answerBranch1Website('פתח אתר התאבות',context,services);
  assert.equal(isBranch1WebsiteRequest('כן בדיוק',context),true);
  assert.match(await answerBranch1Website('כן בדיוק',context,services),/תחילת התוכן המקורי/);
  assert.equal(context.currentWebsiteUrl,'https://www.hidabroot.org/');
});

test('page reference retries the exact pending URL when first retrieval fails',async()=>{
  const context={};let calls=0;
  const services={...deps(),read:async({url})=>{assert.equal(url,'https://www.hidabroot.org/');return ++calls===1?null:{url,title:'הידברות',content};}};
  assert.match(await answerBranch1Website('פתח אתר הידברות',context,services),/לא הצלחתי לקרוא/);
  assert.equal(isBranch1WebsiteRequest('את הדף שנפתח לך שפתחת',context),true);
  assert.match(await answerBranch1Website('את הדף שנפתח לך שפתחת',context,services),/תחילת התוכן המקורי/);
  assert.equal(calls,2);
});

test('a failed switch never reads old site content as though the new site opened',async()=>{
  const context={};await answerBranch1Website('פתח אתר הידברות',context,deps());
  let attempts=0;
  const services={logger:quiet,search:async()=>[{title:'אתר חדש',url:'https://new.example/'}],read:async({url})=>{assert.equal(url,'https://new.example/');attempts++;return attempts===1?null:{url,title:'אתר חדש',content:'טקסט מהאתר החדש '.repeat(30)};}};
  await answerBranch1Website('פתח אתר חדש',context,services);
  const answer=await answerBranch1Website('תקרא את הדף שפתחת',context,services);
  assert.match(answer,/טקסט מהאתר החדש/);assert.doesNotMatch(answer,/התוכן המקורי/);assert.equal(attempts,2);
});

test('extraction fallback retains real same-site links for spoken navigation',async()=>{
  const context={};let reads=0;
  const services={logger:quiet,read:async()=>{reads++;return null;},extract:async url=>({url,content:'תוכן '.repeat(30)+'[חדשות היום](/news) [חיצוני](https://other.example/)'}),search:async()=>[]};
  await answerBranch1Website('פתח אתר הידברות',context,services);
  assert.equal(context.currentWebsitePages[0].links.length,1);
  assert.match(await answerBranch1Website('איזה קישורים יש',context,services),/חדשות היום/);
  await answerBranch1Website('פתח קישור אחד',context,services);
  assert.equal(context.currentWebsiteUrl,'https://www.hidabroot.org/news');assert.equal(reads,2);
});

test('source questions return actual page identity; generic earlier-topic wording does not reopen a stale site',async()=>{
  const context={};await answerBranch1Website('פתח אתר הידברות',context,deps());
  assert.equal(isBranch1WebsiteRequest('מאיזה מקור המידע?',context),true);
  assert.match(await answerBranch1Website('מאיזה מקור המידע?',context,deps()),/https:\/\/www.hidabroot.org\//);
  context.lastRoute='events';
  assert.equal(isBranch1WebsiteRequest('תסביר את האירוע מההתחלה',context),false);
  assert.equal(isBranch1WebsiteRequest('תקרא לי את הדף שפתחת מההתחלה',context),true);
});

test('reader starts in a balanced main content div and keeps all articles inside it',async()=>{
  const before=globalThis.fetch;
  globalThis.fetch=async()=>new Response('<html><title>אתר לדוגמה</title><body><div>תפריט ארוך שאינו תוכן</div><div id="content"><div><article>תוכן ראשון '+('א '.repeat(50))+'</article></div><div><article>תוכן שני '+('ב '.repeat(50))+'</article><a href="/story">כתבה לקריאה</a></div></div><div>פרסומת חיצונית לסוף</div></body></html>',{headers:{'content-type':'text/html'}});
  try{
    const page=await readSinglePublicWebsitePage({url:'https://example.org/'});
    assert.match(page.content,/תוכן ראשון/);assert.match(page.content,/תוכן שני/);assert.doesNotMatch(page.content,/תפריט ארוך|פרסומת חיצונית/);
    assert.equal(page.links[0].url,'https://example.org/story');
  }finally{globalThis.fetch=before;}
});
