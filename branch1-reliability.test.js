import * as turnContextHelpers from './branch1-turn-context.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
import {resolveBranch1Question, isCorrection, branch1SpeechItems, answerBranch1Local, answerBranch1Events, createBranch1Search, filterBranch1Results, isBranch1LocalRequest} from './branch1-reliability.js';

test('branch1 generic web results require the requested city and topic',()=>{
  const input=[{title:'חנויות ירושלים',snippet:'חנויות בקניון רמות'}, {title:'חדשות קרית גת',snippet:'חדשות ספורט'}, {title:'חנויות קרית גת',snippet:'כתובת עסק'}];
  assert.equal(filterBranch1Results('חנויות קריית גת',input).length,1);
  assert.equal(isBranch1LocalRequest('מה שעות חנות ברמות דוד בקרית גת'),false);
});

test('correction reruns the resolved user question, not the irrelevant answer', () => {
  assert.equal(isCorrection('לא הבנת מה שאמרתי'),true);
  assert.equal(resolveBranch1Question('לא הבנת מה שאמרתי', [{user:'איזה חנות יש ברמות דוד בקריאת גת',resolvedQuestion:'איזה חנות יש ברמות דוד בקריית גת',assistant:'קניון רמות בירושלים'}]),'איזה חנות יש ברמות דוד בקריית גת');
  assert.equal(resolveBranch1Question('איזה חנות יש ברמות דוד בקריאת גת'), 'איזה חנות יש ברמות דוד בקריית גת');
  assert.equal(resolveBranch1Question('לא התכוונתי לירושלים אלא לבית שמש',[{user:'מה יש בירושלים'}]), 'לא התכוונתי לירושלים אלא לבית שמש');
});

test('ambiguous city asks once and accepts the city as a follow-up', async () => {
  const q='איזה חנות יש ברמות דוד ב השכונה בתוך קריאת';
  const response=await answerBranch1Local(q,()=>{throw Error('must not search ambiguous city');});
  assert.match(response,/באיזו עיר/);
  assert.match(resolveBranch1Question('בקרית גת',[{user:q}]),/רמות דוד.*קרית גת/);
});

test('local results reject the reported Jerusalem protest even if city appears in metadata', async () => {
  const q='איזה חנות יש ברמות דוד בקרית גת';
  const response=await answerBranch1Local(q,async()=>[
    {title:'פשקוויל קניון רמות',snippet:'רמות דוד קרית גת כתובת חנויות חרם',url:'https://example.org/protest'},
    {title:'חנות בירושלים',snippet:'קניון רמות בירושלים כתובת',url:'https://example.org/wrong'}
  ]);
  assert.match(response,/לא הצלחתי לאמת/);
  assert.doesNotMatch(response,/פשקוויל|ירושלים|חרם/);
});

test('relevant local listing is returned without any generation call', async () => {
  const response=await answerBranch1Local('איזה חנות יש ברמות דוד בקרית גת',async()=>[
    {title:'מכולת לדוגמה',snippet:'כתובת רמות דוד קרית גת',url:'https://example.org/shop'}
  ]);
  assert.match(response,/מכולת לדוגמה/);
  assert.match(response,/לא אומתו/);
});

test('culture request asks a date; dated request rejects an old publication', async () => {
  assert.match(await answerBranch1Events('איזה פעילות יש בבית שמש הופעה משהו תרבותי',()=>{throw Error('no date');}),/להיום, למחר/);
  assert.match(await answerBranch1Events('הופעה היום בבית שמש',async()=>[{title:'הופעה בבית שמש',snippet:'פורסם 25.10.2020',url:'https://example.org/old'}],{read:async()=>({url:'https://example.org/old',title:'בית שמש',content:'פורסם 25.10.2020 הופעה בבית שמש בשעה 20:00'})}),/לא מצאתי/);
});

test('current event listing retains source and availability qualification',async()=>{
  const date=new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Jerusalem',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date());
  const answer=await answerBranch1Events('הופעה היום בבית שמש',async()=>[],{read:async()=>({url:'https://example.org/event',title:'בית שמש',content:'מופע לדוגמה בבית שמש '+date+' 20:00 היכל התרבות'})});
  assert.match(answer,/מופע לדוגמה/);
  assert.match(answer,/לבדוק מול המארגן/);
});

test('speech chunks preserve complete long answer and strip protocol controls',()=>{
  const input=('שלום עולם '.repeat(200)+'|&\u202e🎵');
  const items=branch1SpeechItems(input);
  assert.ok(items.length>1);
  assert.ok(items.every(x=>x.type==='text'&&x.data.length<=400));
  assert.equal(items.map(x=>x.data).join(' '),'שלום עולם '.repeat(200).trim());
});

test('search coalesces concurrent requests, expires cached results, retries failures', async()=>{
  let now=0,calls=0;
  const search=createBranch1Search(async()=>{calls++;return [{title:'test'}];},{ttlMs:30,now:()=>now});
  await Promise.all([search('same'),search('same')]);
  assert.equal(calls,1);now=31;await search('same');assert.equal(calls,2);
  let failures=0;
  const failing=createBranch1Search(async()=>{failures++;throw Error('quota');});
  await assert.rejects(failing('q'));await assert.rejects(failing('q'));assert.equal(failures,2);
});

test('actual branch1 handler survives a conversation model timeout without searching',async()=>{
  const source=readFileSync(new URL('./server.js',import.meta.url),'utf8');
  const handler=source.slice(source.indexOf('async function callHandler(call)'),source.indexOf('\n\n/**\n * Isolated YouTube'));
  let reads=0,fallbacks=0;
  const context={...turnContextHelpers,console:{info(){},warn(){},error(){}},Buffer,Date,Intl,process:{env:{ENABLE_AI_OPENING:'false'}},
    getCallerNumber:()=> 'anonymous',activeCalls:new Map(),conversationLog:[],branch1SpeechItems,
    isCallerHangupError:e=>e.message==='hangup',geminiErrorStatus:e=>e.status||0,
    REQUEST_TIMEOUT_MS:30000,withTimeout:async p=>p,yemotApi:{download_file:async()=>({data:Buffer.from('audio')})},
    buildCallHistoryText:async()=>'',transcribePhoneAudio:async()=> 'מה היתרונות של אנרגיה סולרית',
    resolvePendingLookupQuestion:()=>'',resolveBranch1Question,isCorrection,selectRelevantHistoryForTurn:()=>'',
    branch1Clarification:()=>'',branch1FollowUpHistory:()=>'',isBranch1WebsiteRequest:()=>false,isBranch1LocalRequest:()=>false,isBranch1EventRequest:()=>false,
    isMultimodalAnalysisRequest:()=>({any:false}),isVisualContinuationRequest:()=>false,
    answerIsraelTimeQuestion:()=>'',answerDailyDateQuestion:()=>'',EXCLUSIVE_INSTRUCTION:'',LONG_ANSWER_MAX_CHARS:12000,
    generateBranch1WithFallback:async()=>{throw Object.assign(Error('timeout'),{status:408});},
    logDetailedError(){},answerWithDirectWebFallback:async(q,h)=>{assert.equal(h,'');fallbacks++;return 'תשובה מהמקורות';},
    sanitizeForYemot:x=>x,correctKnownSpeechNames:x=>x,rewriteFollowUp:async q=>q,normalizePhone:x=>x,persistConversationEntry:async()=>{},MAX_CONVERSATION_LOG:1000};
  for(const key of ['isWeatherQuestion','isNewsQuestion','isWebsiteCapabilityQuestion','isWebsiteNavigationRequest','isGenericWebsiteRequest','shouldForceWebSearch','isLongAnswerRequest','isDeepWebSearchRequest','isTransitRequest','isPhoneNumberRequest','isPharmacySearchRequest','isBusinessHoursRequest']) context[key]=()=>false;
  context.extractExplicitHttpUrl=()=>'';
  context.callPersona={getStore:()=>({branch:'1'})};
  context.branch1WebSearchSubject=()=>null;
  vm.createContext(context);vm.runInContext(handler+'\nglobalThis.handler=callHandler;',context);
  await context.handler({read:async items=>{if(/להקלדה במקשי/.test(items[0]?.data))return '1';reads++;if(reads===1)return '/audio.wav';assert.match(items[0].data,/יותר מדי זמן/);throw Error('hangup');}});
  assert.equal(fallbacks,0);assert.equal(reads,2);assert.equal(context.activeCalls.size,0);
});

test('extension 1 typing: key 2 takes the question from the Hebrew phone keyboard, no recording or transcription',async()=>{
  const source=readFileSync(new URL('./server.js',import.meta.url),'utf8');
  const handler=source.slice(source.indexOf('async function callHandler(call)'),source.indexOf('\n\n/**\n * Isolated YouTube'));
  let reads=0,fallbacks=0;
  const context={...turnContextHelpers,console:{info(){},warn(){},error(){}},Buffer,Date,Intl,process:{env:{ENABLE_AI_OPENING:'false'}},
    getCallerNumber:()=> 'anonymous',activeCalls:new Map(),conversationLog:[],branch1SpeechItems,
    isCallerHangupError:e=>e.message==='hangup',geminiErrorStatus:e=>e.status||0,
    REQUEST_TIMEOUT_MS:30000,withTimeout:async p=>p,yemotApi:{download_file:async()=>{throw Error('no recording expected');}},
    buildCallHistoryText:async()=>'',transcribePhoneAudio:async()=>{throw Error('no transcription expected');},
    resolvePendingLookupQuestion:()=>'',resolveBranch1Question,isCorrection,selectRelevantHistoryForTurn:()=>'',
    branch1Clarification:()=>'',branch1FollowUpHistory:()=>'',isBranch1WebsiteRequest:()=>false,isBranch1LocalRequest:()=>false,isBranch1EventRequest:()=>false,
    isMultimodalAnalysisRequest:()=>({any:false}),isVisualContinuationRequest:()=>false,
    answerIsraelTimeQuestion:()=>'',answerDailyDateQuestion:()=>'',EXCLUSIVE_INSTRUCTION:'',LONG_ANSWER_MAX_CHARS:12000,
    generateBranch1WithFallback:async()=>{throw Object.assign(Error('timeout'),{status:408});},
    logDetailedError(){},answerWithDirectWebFallback:async(q,h)=>{assert.equal(h,'');fallbacks++;return 'תשובה מהמקורות';},
    sanitizeForYemot:x=>x,correctKnownSpeechNames:x=>x,rewriteFollowUp:async q=>q,normalizePhone:x=>x,persistConversationEntry:async()=>{},MAX_CONVERSATION_LOG:1000};
  for(const key of ['isWeatherQuestion','isNewsQuestion','isWebsiteCapabilityQuestion','isWebsiteNavigationRequest','isGenericWebsiteRequest','shouldForceWebSearch','isLongAnswerRequest','isDeepWebSearchRequest','isTransitRequest','isPhoneNumberRequest','isPharmacySearchRequest','isBusinessHoursRequest']) context[key]=()=>false;
  context.extractExplicitHttpUrl=()=>'';
  context.callPersona={getStore:()=>({branch:'1'})};
  context.branch1WebSearchSubject=()=>null;
  vm.createContext(context);vm.runInContext(handler+'\nglobalThis.handler=callHandler;',context);
  const modes=[];
  await context.handler({read:async (items,mode,opts)=>{
    if(/להקלדה במקשי/.test(items[0]?.data)){modes.push('menu');return '2';}
    reads++;modes.push(mode+':'+(opts?.typing_playback_mode||''));
    if(reads===1){assert.match(items.map(x=>x.data).join(' '),/סולמית אחרי כל אות/);return 'מה היתרונות של אנרגיה סולרית';}
    assert.match(items[0].data,/יותר מדי זמן/);throw Error('hangup');}});
  assert.deepEqual(modes,['menu','tap:HebrewKeyboard','tap:HebrewKeyboard']);
  assert.equal(fallbacks,0);assert.equal(reads,2);assert.equal(context.activeCalls.size,0);
});

