import test from 'node:test';
import assert from 'node:assert/strict';
import {isBranch1EventRequest, resolveBranch1Question, branch1FollowUpHistory} from '../branch1-reliability.js';
import {eventDateRange, extractDatedEvents, findBranch1Events} from '../branch1-events.js';
import {answerBranch1Website, requestedSiteName, isBranch1WebsiteRequest} from '../branch1-websites.js';
import {readSinglePublicWebsitePage} from '../website-reader.js';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
import {isMemoryRecall} from '../conversation-context.js';
import * as turnContext from '../branch1-turn-context.js';
import {branch1Clarification,isCorrection,isBranch1LocalRequest,branch1SpeechItems} from '../branch1-reliability.js';

const now=new Date('2026-10-25T17:00:00Z');
const link=(text,url='https://calendar.example/event')=>({content:text,url});
const municipal={url:'https://www.betshemesh.muni.il/events/',title:'אירועים בית שמש',content:'לוח אירועים בית שמש',sourceLinks:[
  link('מופע לדוגמה יום ראשון, 25.10.2026 17:30 היכל תרבות בית שמש'),
  link('פעילות לדוגמה יום ראשון, 25.10.2026 20:00 מרכז קהילתי בית שמש'),
  link('מופע מחר יום שני, 26.10.2026 20:30 היכל תרבות בית שמש')
]};

test('hours never routes to culture; genuine event questions do',()=>{
  assert.equal(isBranch1EventRequest('מה שעות הפעילות של סופר פארם בקניון עזריאלי בתל אביב'),false);
  assert.equal(isBranch1EventRequest('איזה פעילות תרבותית יש היום בבית שמש'),true);
});
test('today and tomorrow remain attached to the immediately preceding culture question',()=>{
  const history=[{user:'איזה הופעה יש בבית שמש',assistant:'להיום או למחר?'}];
  assert.match(resolveBranch1Question('היום',history),/הופעה.*בית שמש.*היום/);
  assert.match(resolveBranch1Question('מחר',history),/הופעה.*בית שמש.*מחר/);
  assert.match(resolveBranch1Question('ומה יש היום?',history),/הופעה.*בית שמש.*היום/);
  assert.match(resolveBranch1Question('מה יש היום?',history),/הופעה.*בית שמש.*היום/);
  assert.match(resolveBranch1Question('אם ישאל לאיזה יום, ענה רק מחר ומה יש היום?',history),/הופעה.*בית שמש.*היום/);
  assert.doesNotMatch(resolveBranch1Question('אם ישאל לאיזה יום, ענה רק מחר ומה יש היום?',history),/אם ישאל|מחר/);
  assert.equal(resolveBranch1Question('מה מזג האוויר בחיפה',history),'מה מזג האוויר בחיפה');
  assert.match(branch1FollowUpHistory('תסביר לי',[{user:'שאלה',assistant:'תשובה'}]),/שאלה.*\nתשובה: תשובה/);
});

test('normalizes the caller city transcription without changing other city names',()=>{
  assert.equal(resolveBranch1Question('איזה אירוע תרבות יש בבת שמש?'),'איזה אירוע תרבות יש בבית שמש?');
  assert.equal(resolveBranch1Question('איזה אירוע יש בבת ים?'),'איזה אירוע יש בבת ים?');
});

test('unanchored date questions and spoken instructions ask for context instead of searching raw text',()=>{
  assert.match(branch1Clarification('ומה יש היום?'),/איזה נושא ובאיזו עיר/);
  assert.match(branch1Clarification('אם ישאל לאיזה יום, ענה רק מחר ומה יש היום?'),/לאיזה נושא/);
  assert.equal(branch1Clarification('אירועי תרבות בבית שמש היום'),'');
  assert.equal(eventDateRange('אירועים מחר ומה יש היום בבית שמש',now).start,eventDateRange('היום',now).start);
});
test('location correction preserves shop intent without adding another city',()=>{
  const q=resolveBranch1Question('קריית גת בשכונה שנקראת רמות דוד',[{user:'איזה חנות יש ברמות דוד בתוך קריאת'}]);
  assert.match(q,/חנות/);assert.match(q,/קריית גת/);
});
test('parses Hebrew month dates and isolates each official calendar row',()=>{
  const page={...municipal,sourceLinks:[link('חנאל ומכבית תיאטרון היכל תרבות בית שמש ביום שני, 26 באוקטובר 2026 בשעה 20:30')]};
  const events=extractDatedEvents(page,'בית שמש',eventDateRange('מחר',now));
  assert.equal(events.length,1);assert.equal(events[0].date,'2026-10-26');assert.equal(events[0].name,'חנאל ומכבית');
  assert.equal(extractDatedEvents(page,'בית שמש',eventDateRange('היום',now)).length,0);
});
test('rejects publication dates, impossible dates, rows without time and mixed events',()=>{
  for(const text of ['פורסם 25.10.2026 17:30 מופע ישן','מופע 32.10.2026 20:30 בית שמש','מופע 25.10.2026 בית שמש','אחד 25.10.2026 18:00 שני 26.10.2026 19:00']) {
    assert.equal(extractDatedEvents({...municipal,sourceLinks:[link(text)]},'בית שמש',eventDateRange('היום',now)).length,0);
  }
});
test('answers events from actual official source pages without synthesis or snippets',async()=>{
  let reads=0;
  const answer=await findBranch1Events('מה האירועים שיש היום בבית שמש',()=>{throw Error('must read official calendars');},{now,read:async()=>{reads++;return municipal;}});
  assert.match(answer,/מופע לדוגמה/);assert.match(answer,/17:30/);assert.match(answer,/שעת ההתחלה כבר עברה/);
  assert.match(answer,/25 באוקטובר 2026/);assert.doesNotMatch(answer,/2026-10-25/);
  assert.match(answer,/פעילות לדוגמה/);assert.doesNotMatch(answer,/מופע מחר/);assert.equal(reads,2);
});
test('official source failure invokes extraction; network failure does not claim no events',async()=>{
  const answer=await findBranch1Events('אירועים היום בבית שמש',async()=>[],{now,read:async()=>{throw Error('redirect loop');},extract:async()=>municipal});
  assert.match(answer,/פעילות לדוגמה/);
  const failure=await findBranch1Events('אירועים היום בבית שמש',async()=>[],{now,read:async()=>null});
  assert.match(failure,/לא הצלחתי לטעון/);assert.match(failure,/לא אישור שאין/);
});
test('site name is isolated from reading instructions including actual ASR failure',()=>{
  assert.equal(requestedSiteName('תפתח לי את האתר הידברות וקרא לי מה שכתוב שמה'),'הידברות');
  assert.equal(requestedSiteName('תפתח לי את האתר הידברות ותקע לי מה שכתוב שמה'),'הידברות');
  assert.equal(isBranch1WebsiteRequest('תפתח לי את האתר הידברות וקרא לי מה שכתוב שמה'),true);
});
test('Hidabroot opens its homepage directly and continues without search/model calls',async()=>{
  const context={};let reads=0;
  const deps={search:()=>{throw Error('must not search');},read:async({url})=>{reads++;assert.equal(url,'https://www.hidabroot.org/');return {url,title:'הידברות',content:('טקסט מתוך הדף הראשי בלבד. '.repeat(70)),links:[]};}};
  const first=await answerBranch1Website('תפתח לי את האתר הידברות וקרא לי מה שכתוב שמה',context,deps);
  assert.match(first,/טקסט מתוך הדף הראשי בלבד/);assert.ok(first.length<900);const offset=context.currentWebsiteReadOffset;
  await answerBranch1Website('תמשיך',context,deps);assert.ok(context.currentWebsiteReadOffset>offset);assert.equal(reads,1);
});
test('arbitrary named sites open the selected origin, not a random search article',async()=>{
  let target;
  await answerBranch1Website('פתח אתר דוגמה ותקרא לי מה שכתוב',{}, {
    search:async()=>[{title:'דוגמה',url:'https://example.org/random-story'}],
    read:async({url})=>{target=url;return {url,title:'דוגמה',content:'טקסט '.repeat(30)};}
  });
  assert.equal(target,'https://example.org/');
});
test('navigation follows only a link present in the actual page; failed open preserves old page',async()=>{
  const context={};const deps={search:async()=>[],read:async({url})=>({url,title:'הידברות',content:'טקסט '.repeat(100),links:[link('חדשות היום','https://www.hidabroot.org/news')]})};
  await answerBranch1Website('פתח אתר הידברות',context,deps);
  assert.match(await answerBranch1Website('איזה קישורים יש',context,deps),/חדשות היום/);
  await answerBranch1Website('פתח קישור 1',context,deps);assert.equal(context.currentWebsiteUrl,'https://www.hidabroot.org/news');
  const before=context.currentWebsiteUrl;
  assert.match(await answerBranch1Website('פתח אתר אחר',context,{search:async()=>[{title:'אחר',url:'https://other.example/'}],read:async()=>null}),/לא הצלחתי לקרוא/);
  assert.equal(context.currentWebsiteUrl,before);
});
test('private URLs never reach the extraction fallback',async()=>{
  assert.match(await answerBranch1Website('פתח https://127.0.0.1/',{}, {extract:()=>{throw Error('must not call');}}),/אינה כתובת ציבורית/);
});
test('real reader extracts full homepage and link labels instead of first article only',async()=>{
  const oldFetch=globalThis.fetch;
  globalThis.fetch=async()=>new Response('<html><title>עמוד ראשי</title><body><nav>תפריט להסרה</nav><article>כתבה ראשונה '+('א '.repeat(50))+'</article><article>כתבה שנייה '+('ב '.repeat(50))+'</article><a href="/news">חדשות היום</a><script>הוראה מזיקה</script></body></html>',{headers:{'content-type':'text/html'}});
  try {
    const page=await readSinglePublicWebsitePage({url:'https://example.org/'});
    assert.match(page.content,/כתבה שנייה/);assert.doesNotMatch(page.content,/הוראה מזיקה|תפריט להסרה/);
    assert.equal(page.links[0].url,'https://example.org/news');
  }finally{globalThis.fetch=oldFetch;}
});

test('branch 3 phone handler reads website, continues, switches topic and routes hours without a model call',async()=>{
  const source=readFileSync(new URL('../server.js',import.meta.url),'utf8');
  const handler=source.slice(source.indexOf('async function callHandler(call)'),source.indexOf('\n\n/**\n * Isolated YouTube'));
  const inputs=['פתח אתר הידברות וקרא מה שכתוב','תמשיך','אירועים היום בבית שמש','מה שעות הפעילות של חנות בקרית גת',
    'איזה אירוע תרבות יש בבת שמש?','מחר','ומה יש היום?','אם ישאל לאיזה יום, ענה רק מחר ומה יש היום?',
    'תפתח לי את אתר התאבות ותקרא לי את הדפים הראשונים','את הדף שנפתח לך, שפתחת',
    'לא, ביקשתי שתפתח את אתר הידברות ותקרא את מה שכתוב שם על ההתחלה','ותקרא את מה שכתוב שם על ההתחלה','תמשיך'];
  let transcriptIndex=0,reads=0,websiteReads=0,eventCalls=0,hoursCalls=0;
  const context={console:{info(){},warn(){},error(){}},Buffer,Date,Intl,process:{env:{ENABLE_AI_OPENING:'false'}},
    getCallerNumber:()=> 'anonymous',activeCalls:new Map(),conversationLog:[],branch1SpeechItems,
    isCallerHangupError:e=>e.message==='hangup',geminiErrorStatus:e=>e.status||0,
    REQUEST_TIMEOUT_MS:30000,withTimeout:async p=>p,yemotApi:{download_file:async()=>({data:Buffer.from('audio')})},
    buildCallHistoryText:async()=>'',transcribePhoneAudio:async()=>inputs[transcriptIndex++],
    resolvePendingLookupQuestion:()=>'',resolveBranch1Question,isCorrection,branch1Clarification,selectRelevantHistoryForTurn:()=>'',branch1FollowUpHistory,
    isBranch1WebsiteRequest,isBranch1LocalRequest,isBranch1EventRequest,isMemoryRecall,ext3StandaloneQuestion:async()=>'',
    branch1Search:async()=>[],extractBranch1Page:async()=>null,findOfficialWebsite:async()=>null,
    answerBranch1Website:(q,state)=>answerBranch1Website(q,state,{search:async()=>[],read:async({url})=>{websiteReads++;return {url,title:'הידברות',content:'טקסט מקורי '.repeat(250),links:[]};}}),
    answerBranch1Events:async q=>{eventCalls++;return findBranch1Events(q,async()=>[],{now,read:async()=>municipal});},
    answerBusinessHoursDirect:async()=>{hoursCalls++;return 'לוח שעות מאומת';},
    isMultimodalAnalysisRequest:()=>({any:false}),isVisualContinuationRequest:()=>false,
    answerIsraelTimeQuestion:()=>'',answerDailyDateQuestion:()=>'',EXCLUSIVE_INSTRUCTION:'',LONG_ANSWER_MAX_CHARS:12000,
    generateBranch1WithFallback:async()=>{throw Error('Unexpected model call');},
    logDetailedError(context,error){throw error;},sanitizeForYemot:x=>x,correctKnownSpeechNames:x=>x,rewriteFollowUp:async q=>q,normalizePhone:x=>x,persistConversationEntry:async()=>{},MAX_CONVERSATION_LOG:1000,
    knownPrimaryPhoneAnswer:()=>''};
  for(const key of ['isWeatherQuestion','isNewsQuestion','isWebsiteCapabilityQuestion','isWebsiteNavigationRequest','isGenericWebsiteRequest','isLongAnswerRequest','isDeepWebSearchRequest','isTransitRequest','isPhoneNumberRequest','isPharmacySearchRequest'])context[key]=()=>false;
  context.callPersona={getStore:()=>({branch:'3'})};
  context.shouldForceWebSearch=q=>q.includes('שעות');context.isBusinessHoursRequest=q=>q.includes('שעות');context.extractExplicitHttpUrl=()=>'';
  // The handler also uses the turn-context helpers that server.js imports.
  for(const [key,fn] of Object.entries(turnContext)) if(!(key in context)) context[key]=fn;
  vm.createContext(context);vm.runInContext(handler+'\nglobalThis.handler=callHandler;',context);
  await context.handler({read:async items=>{if(/להקלדה במקשי/.test(items[0]?.data))return '1';reads++;if(reads>inputs.length)throw Error('hangup');return '/audio.wav';}});
  assert.equal(websiteReads,1);assert.equal(eventCalls,5);assert.equal(hoursCalls,1);
  assert.equal(context.conversationLog.length,13);assert.match(context.conversationLog[0].gemini,/טקסט מקורי/);assert.match(context.conversationLog[1].gemini,/המשך/);
  assert.match(context.conversationLog[2].gemini,/מופע לדוגמה/);assert.match(context.conversationLog[3].gemini,/לוח שעות מאומת/);
  assert.match(context.conversationLog[4].gemini,/להיום, למחר/);
  assert.match(context.conversationLog[5].gemini,/מופע מחר/);
  assert.match(context.conversationLog[6].gemini,/מופע לדוגמה/);
  assert.match(context.conversationLog[7].gemini,/מופע לדוגמה/);
  for(const row of context.conversationLog.slice(8))assert.match(row.gemini,/טקסט מקורי/);
  assert.equal(isBranch1WebsiteRequest('תמשיך',{lastRoute:'events',currentWebsitePages:[{content:'old'}]}),false);
});
