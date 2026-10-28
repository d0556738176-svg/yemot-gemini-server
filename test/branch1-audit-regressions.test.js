import test from 'node:test';
import { selectReferencedVideo } from '../visual-intent.js';
import assert from 'node:assert/strict';
import { resolveBranch1Question } from '../branch1-reliability.js';
import { selectRelevantHistoryForTurn } from '../conversation-context.js';
import { extractPageMedia } from '../website-reader.js';
import { answerBranch1Website, isBranch1WebsiteRequest } from '../branch1-websites.js';
import { callCompatibleChatCompletion } from '../provider-fallback.js';

for(const followup of ['ומחר?','לא, מחר','מחרתיים','אז מחר']) {
  test('event topic and location survive date follow-up: '+followup,()=>{
    const q=resolveBranch1Question(followup,[{user:'איזה מופע יש בבית שמש היום?',assistant:'בודק'}]);
    assert.match(q,/מופע/); assert.match(q,/בית שמש/); assert.doesNotMatch(q,/היום/);
    assert.match(q,/מחר/);
  });
}
test('date follow-up does not change an explicit new topic',()=>{
  assert.equal(resolveBranch1Question('מה מזג האוויר מחר בירושלים',[{user:'איזה מופע בבית שמש היום'}]),'מה מזג האוויר מחר בירושלים');
});
test('third event date retains the resolved event topic',()=>{
  const history=[{user:'איזה מופע בבית שמש היום'},{user:'ומחר',resolvedQuestion:'איזה מופע בבית שמש מחר'}];
  assert.match(resolveBranch1Question('מחרתיים',history),/מופע בבית שמש מחרתיים/);
});
test('short natural consultation response keeps current context',()=>{
  assert.match(selectRelevantHistoryForTurn('נשמע יקר מדי','', [{user:'איזה מחשב לבחור',assistant:'האפשרות עולה אלף'}]),/מחשב/);
});
test('article media keeps real URLs and excludes nonpublic candidates',()=>{
  const result=extractPageMedia('<meta property="og:image" content="/cover.jpg"><img src="http://127.0.0.1/private"><iframe src="https://www.youtube.com/embed/abc123"></iframe>','https://example.org/article');
  assert.equal(result.images[0].url,'https://example.org/cover.jpg');
  assert.equal(result.images.length,1); assert.equal(result.videos.length,1);
});
test('page details use the selected page without another site search',async()=>{
  const page={url:'https://example.org/story',title:'כתבה',content:'מידע אמיתי '.repeat(20),links:[]};
  const context={lastRoute:'website',currentWebsitePages:[page],currentWebsitePageIndex:0};
  assert.equal(isBranch1WebsiteRequest('כמה עולה הכרטיס בעמוד הזה',context),true);
  const answer=await answerBranch1Website('כמה עולה הכרטיס בעמוד הזה',context,{answerPage:async(q,p)=>{assert.equal(p,page);return 'המחיר אינו מופיע בעמוד';},search:()=>{throw Error('unexpected search');}});
  assert.equal(answer,'המחיר אינו מופיע בעמוד');
});
test('website reading maintains offset across continuation',async()=>{
  const context={lastRoute:'website',currentWebsitePages:[{url:'https://example.org',content:'מילה '.repeat(800),links:[]}],currentWebsiteReadOffset:0};
  await answerBranch1Website('תקרא',context,{}); const first=context.currentWebsiteReadOffset;
  await answerBranch1Website('תמשיך',context,{}); assert.ok(context.currentWebsiteReadOffset>first);
});
test('cancelled losing provider does not burn cooldown or make a request',async()=>{
  const controller=new AbortController();controller.abort();const cooldowns=new Map();
  await assert.rejects(callCompatibleChatCompletion({provider:'test',apiKey:'test',model:'test',baseUrl:'https://example.org',messages:[{role:'user',content:'test'}],signal:controller.signal,cooldowns,fetchImpl:()=>{throw Error('must not fetch');}}),e=>e.status===499);
  assert.equal(cooldowns.size,0);
});

test('video ordinal selects second result instead of pinned first',()=>{
 const first={videoId:'first'},second={videoId:'second'};
 assert.equal(selectReferencedVideo('נתח את הסרטון השני',{currentVideo:first,youtubeResults:[first,second]}),second);
 assert.equal(selectReferencedVideo('נתח את הסרטון מספר 9',{currentVideo:first,youtubeResults:[first,second]}),null);
});
