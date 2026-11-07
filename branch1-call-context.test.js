import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import vm from 'node:vm';
import * as turn from './branch1-turn-context.js';
import * as history from './conversation-context.js';
import {branch1WebSearchSubject,shouldForceWebSearch} from './branch1-web-router.js';

async function runCall(questions,answers,{branch="1"}={}){
 const source=await fs.readFile(new URL('./server.js',import.meta.url),'utf8');
 const begin=source.indexOf('async function callHandler(call)');
 const end=source.indexOf('\n\n/**',begin);
 const prompts=[],spoken=[],searches=[];let index=0,generations=0;
 const context={...turn,...history,process:{env:{ENABLE_AI_OPENING:'false'}},console:{info(){},warn(){},error(){}},Buffer,Date,Intl,
  activeCalls:new Map(),conversationLog:[],MAX_CONVERSATION_LOG:100,REQUEST_TIMEOUT_MS:10000,LONG_ANSWER_MAX_CHARS:10000,EXCLUSIVE_INSTRUCTION:'ענה על הבקשה בהקשר השיחה',
  branch1SpeechItems:text=>[{type:'text',data:text}],geminiErrorStatus:e=>e.status||0,
  getCallerNumber:()=> 'fixture',normalizePhone:x=>x,withTimeout:p=>p,
  yemotApi:{download_file:async()=>({data:Buffer.from('fixture')})},
  isCallerHangupError:e=>e.name==='HangupError',correctKnownSpeechNames:x=>x,
  transcribePhoneAudio:async()=>questions[index++],resolveBranch1Question:q=>q,
  branch1FollowUpHistory:()=>'',shouldForceWebSearch,branch1WebSearchSubject,
  callPersona:{getStore:()=>({branch})},
  generateBranch1WithFallback:async contents=>{prompts.push(contents[0].parts[0].text);return {response:{text:()=>JSON.stringify({answer:answers[generations++]||'תשובה בהקשר'})}};},
  answerBranch1Web:async q=>{searches.push(q);return 'לא מצאתי מידע מאומת על השירים';},
  searchYouTubeForPhone:async(q,h,c)=>{searches.push(q);c.currentVideo={videoId:'abcdefghijk'};c.youtubeResults=[{}];return 'תוצאות השירים';},
  sanitizeForYemot:x=>x,persistConversationEntry:async()=>{},
  logDetailedError:(label,e)=>{throw new Error(label+': '+e.message);},
  answerDailyDateQuestion:()=>'',answerIsraelTimeQuestion:()=>'',knownPrimaryPhoneAnswer:()=>'',branch1Clarification:()=>'',
 };
 for(const name of ['isPhoneNumberRequest','isBusinessHoursRequest','isLocalBusinessDiscoveryRequest','isCorrection','isBranch1WebsiteRequest','isBranch1LocalRequest','isBranch1EventRequest','isVisualContinuationRequest','isWeatherQuestion','isNewsQuestion','isWebsiteCapabilityQuestion','isWebsiteNavigationRequest','isGenericWebsiteRequest','isLongAnswerRequest','isTransitRequest'])context[name]=()=>false;
 context.isMultimodalAnalysisRequest=()=>({any:false});context.extractExplicitHttpUrl=()=>null;context.extractExplicitLocation=()=>({});
 const scope=vm.createContext(context);
 const buildStart=source.indexOf('async function buildCallHistoryText('),buildEnd=source.indexOf('\nfunction contextualizeSearchQuestion',buildStart);
 const handler=vm.runInContext(source.slice(buildStart,buildEnd)+'\n'+source.slice(begin,end)+';callHandler',scope);
 await handler({callId:'fixture',read:async items=>{spoken.push(items);if(index>=questions.length)throw Object.assign(new Error('done'),{name:'HangupError'});return '/recording';},id_list_message:()=>assert.fail('must stay in call')});
 return {prompts,spoken,searches,generations};
}
test('production call keeps yes attached to clarification and supplies previous answer',async()=>{
 const r=await runCall(['איך מורידים סרטונים מיוטיוב?','כן'],['האם אתה רוצה הסבר על הורדת סרטונים?','הנה ההסבר שביקשת']);
 assert.equal(r.generations,2);assert.match(r.prompts[1],/האם אתה רוצה הסבר על הורדת סרטונים/);
 assert.match(JSON.stringify(r.spoken.at(-1)),/הנה ההסבר שביקשת/);
 assert.doesNotMatch(JSON.stringify(r.spoken),/שמח שעזרתי/);assert.equal(r.searches.length,0);
});
test('branch 3 reruns music lookup rather than inventing a target',async()=>{
 const r=await runCall(['תחפש שירים מזרחיים חדשים ביוטיוב','תמצא לי בכל אופן'],[],{branch:'3'});
 assert.equal(r.searches.length,2);assert.match(r.searches[1],/שירים מזרחיים/);
});
test('branch 3 leaves cached video behind for technical discussion and keeps its context',async()=>{
 const r=await runCall(['תחפש שירים ביוטיוב','אני מנסה להוריד סרטונים מיוטיוב ונתקל בחסימה','אני לא רוצה שתמצא לי שמה אני רוצה שתעזור לי שמה'],['נבדוק מה הודעת השגיאה.','נמשיך לבדוק את התקלה'],{branch:'3'});
 assert.equal(r.searches.length,1);assert.equal(r.generations,2);
 assert.match(r.prompts[1],/נתקל בחסימה/);assert.match(r.prompts[1],/נבדוק מה הודעת השגיאה/);
});

test('branch 1 searches only when the current turn explicitly requests internet search',async()=>{
 const explicit='תחפש באינטרנט מי ראש עיריית בית שמש';
 const r=await runCall(['מה החדשות היום','אל תחפש באינטרנט',explicit,'תמשיך','מה פירוש תחפש באינטרנט'],[]);
 assert.deepEqual(r.searches,[explicit]);
 assert.equal(r.generations,4);
 assert.match(r.prompts[2],/מי ראש עיריית בית שמש/);
});

test('branch 1 asks for a search subject before spending quota on an empty command',async()=>{
 const r=await runCall(['תחפש באינטרנט'],[]);
 assert.equal(r.searches.length,0);
 assert.equal(r.generations,0);
 assert.match(JSON.stringify(r.spoken.at(-1)),/מה תרצה שאחפש/);
});

test('branch 1 applies a bare search command to the previous question in the same call',async()=>{
 const question='איך מייצרים חשמל מפאנל סולארי';
 const r=await runCall([question,'אז תחפש באינטרנט'],[]);
 assert.deepEqual(r.searches,[question]);
 assert.equal(r.generations,1);
});

test('conversation provider falls back on quota and stops at the first successful model',async()=>{
 const source=await fs.readFile(new URL('./server.js',import.meta.url),'utf8');
 const start=source.indexOf('async function tryBranch1ConversationProviders');
 const end=source.indexOf('async function generateBranch1WithFallback',start);
 const attempts=[];
 const run=vm.runInNewContext(source.slice(start,end)+'\ntryBranch1ConversationProviders',{
  process:{env:{GROQ_API_KEY:'fixture',OPENROUTER_API_KEY:'fixture'}},
  console:{info(){},warn(){}},geminiErrorStatus:e=>e.status,
  branch1FallbackProviderCooldowns:new Map(),branch1SynthCooldownsBig:new Map(),
  extraFastProviders:()=>[{name:'Mistral',apiKey:'fixture',model:'mistral-small-latest',timeoutMs:1000}],
  callCompatibleChatCompletion:async({provider,model})=>{
   attempts.push([provider,model]);
   if(provider==='Groq') throw Object.assign(Error('quota'),{status:429});
   return 'תשובה מהמנוע החלופי';
  }
 });
 assert.equal(await run([{role:'user',parts:[{text:'שאלה'}]}],true),'תשובה מהמנוע החלופי');
 assert.deepEqual(attempts,[['Groq','openai/gpt-oss-20b'],['Mistral','mistral-small-latest']]);
});

test('branch 1 uses Aion Labs as a last independent text fallback when configured',async()=>{
 const source=await fs.readFile(new URL('./server.js',import.meta.url),'utf8');
 const start=source.indexOf('async function tryBranch1ConversationProviders');
 const end=source.indexOf('async function generateBranch1WithFallback',start);
 const env={OPENROUTER_API_KEY:'fixture'};
 const attempts=[];
 const run=vm.runInNewContext(source.slice(start,end)+'\ntryBranch1ConversationProviders',{
  process:{env},console:{info(){},warn(){}},geminiErrorStatus:e=>e.status,
  branch1FallbackProviderCooldowns:new Map(),branch1SynthCooldownsBig:new Map(),extraFastProviders:()=>[],
  callCompatibleChatCompletion:async options=>{
   attempts.push(options.provider);
   if(options.provider==='OpenRouter') throw Object.assign(Error('quota'),{status:429});
   assert.equal(options.baseUrl,'https://api.aionlabs.ai/v1');
   assert.equal(options.model,'aion-labs/aion-3.5-mini');
   return 'תשובה בעברית';
  }
 });
 const contents=[{role:'user',parts:[{text:'שאלה'}]}];
 assert.equal(await run(contents,true),'');
 assert.deepEqual(attempts,['OpenRouter']);
 env.AIONLABS_API_KEY='fixture';
 assert.equal(await run(contents,true),'תשובה בעברית');
 assert.deepEqual(attempts,['OpenRouter','OpenRouter','Aion Labs']);
});
