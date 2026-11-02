import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import vm from 'node:vm';
import {isConversationalReference,currentConversationText,resolveLookupContinuation,isYouTubeTechnicalDiscussion,mayUseYouTubeSearch,asksForFeedback} from './branch1-turn-context.js';

const music={user:'איזה שירים מזרחיים וישראלים יצאו היום ביוטיוב?',assistant:'עדיין לא מצאתי רשימה מאומתת.'};
const lookup=q=>/יוטיוב|טלפון|שירים|חפש/u.test(q);
test('real failed search continuation stays on music, not a stale phone lookup',()=>{
 const h=[{user:'מה הטלפון של הבנק?',assistant:'123'},music];
 const q=resolveLookupContinuation('תמצא לי בכל אופן',h,lookup);
 assert.match(q,/שירים מזרחיים/);assert.doesNotMatch(q,/טלפון|בנק/);
 const next={user:'תמצא לי בכל אופן',resolvedQuestion:q,assistant:'עדיין לא מצאתי'};
 assert.match(resolveLookupContinuation('מצאת משהו',[music,next],lookup),/שירים מזרחיים/);
});
test('today reference resolves only from the current topic',()=>{
 const q=resolveLookupContinuation('על מה שאמרת לפני כן אני רוצה שתחפש להיום',[music],lookup);
 assert.match(q,/שירים מזרחיים/);assert.match(q,/להיום/);
 assert.equal(resolveLookupContinuation('מה מזג האוויר בירושלים?',[music],lookup),'מה מזג האוויר בירושלים?');
});
test('Hebrew pronouns and acknowledgement retain full current-call answers',()=>{
 const h=[{user:'איך מטפלים בתקלה בשרת?',assistant:'השלב הראשון הוא לבדוק את החיבור.'}];
 for(const q of ['אתה יכול להגיד לי איך הם עשו את זה?','אני לא רוצה שתמצא לי שמה אני רוצה שתעזור לי שמה','כן','תפרט את השלב הראשון']){
  assert.equal(isConversationalReference(q),true,q);
  assert.match(currentConversationText(h),/השלב הראשון הוא לבדוק את החיבור/);
 }
});
test('yes to clarification or offer is never interpreted as satisfaction feedback',()=>{
 assert.equal(asksForFeedback('האם אתה רוצה לדעת איך מורידים סרטונים או משהו אחר?'),false);
 assert.equal(asksForFeedback('רוצה שאחפש עבורך?'),false);
 assert.equal(asksForFeedback('האם זה עזר?'),true);
});
test('technical discussion and rejected search cannot use cached YouTube results',()=>{
 const context={lastRoute:'youtube',currentVideo:{videoId:'abcdefghijk'},youtubeResults:[{}]};
 for(const q of ['אני מנסה להוריד מהאתר של יוטיוב סרטונים ואני נתקל בחסימה','אני לא רוצה שתמצא לי שמה אני רוצה שתעזור לי שמה','איך מורידים סרטונים מיוטיוב?']){
  assert.equal(isYouTubeTechnicalDiscussion(q),true,q);assert.equal(mayUseYouTubeSearch(q,context),false,q);
 }
 assert.equal(mayUseYouTubeSearch('חפש לי מסעדה בירושלים',context),false);
 assert.equal(mayUseYouTubeSearch('פרטים על תוצאה מספר 1',context),true);
 assert.equal(mayUseYouTubeSearch('פרטים על תוצאה מספר 1',{...context,lastRoute:'web'}),false);
});
test('real production search function returns before network on technical or unrelated request',async()=>{
 const source=await fs.readFile(new URL('./server.js',import.meta.url),'utf8');
 const start=source.indexOf('async function searchYouTubeForPhone(');
 const end=source.indexOf('\nfunction ',start+10);
 // Use the exact function declaration, without importing a running HTTP server.
 const text=source.slice(start,end);
 const context=vm.createContext({process:{env:{YOUTUBE_API_KEY:'fixture'}},mayUseYouTubeSearch,console});
 const search=vm.runInContext(text+';searchYouTubeForPhone',context);
 assert.equal(await search('איך מורידים סרטונים מיוטיוב?','',{lastRoute:'youtube',currentVideo:{videoId:'abcdefghijk'}}),null);
 assert.equal(await search('חפש לי מסעדה בירושלים','',{lastRoute:'youtube',currentVideo:{videoId:'abcdefghijk'}}),null);
});
