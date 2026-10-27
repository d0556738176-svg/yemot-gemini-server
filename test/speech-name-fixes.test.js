import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const source=readFileSync(new URL('../server.js',import.meta.url),'utf8');
const start=source.indexOf('const KNOWN_SPEECH_NAME_FIXES');
const end=source.indexOf('// Query-understanding step');
const context={console:{info(){}}};
vm.createContext(context);
vm.runInContext(source.slice(start,end)+'\nglobalThis.fix=correctKnownSpeechNames;',context);

test('mis-heard bank names are corrected deterministically',()=>{
  assert.equal(context.fix('מה המספר של בעל פגי'),'מה המספר של בנק פאגי');
  assert.equal(context.fix('שלום מה המספר של בת פגי?'),'שלום מה המספר של בנק פאגי?');
  assert.equal(context.fix('מה המספר של פאגי'),'מה המספר של בנק פאגי');
  assert.equal(context.fix('מה המספר של בעל איגוד'),'מה המספר של בנק איגוד');
});

test('correct names and unrelated words are left alone',()=>{
  assert.equal(context.fix('מה המספר של בנק פאגי'),'מה המספר של בנק פאגי');
  assert.equal(context.fix('בנק הפועלים'),'בנק הפועלים');
  assert.equal(context.fix('הגיע פגיעה'),'הגיע פגיעה');
});

const ctx2={console:{info(){}}};
vm.createContext(ctx2);
const s2=source.indexOf('const KNOWN_NAME_HINTS');
const e2=source.indexOf('// Query-understanding step');
const pick=source.slice(source.indexOf('// Pick between Deepgram'),source.indexOf('async function transcribePhoneAudio'));
vm.runInContext(source.slice(s2,e2)+'\n'+pick+'\nglobalThis.choose=chooseBetterTranscript;',ctx2);

test('second-opinion transcript wins only when it contains a known name Deepgram missed',()=>{
  const vocab=['בנק פאגי','ביטוח לאומי'];
  assert.equal(ctx2.choose('מה המספר הבא','מה המספר של בנק פאגי',vocab),'מה המספר של בנק פאגי');
  assert.equal(ctx2.choose('מה מזג האוויר','מה מזג האויר',vocab),'מה מזג האוויר');
  assert.equal(ctx2.choose('מה המספר של ביטוח לאומי','',vocab),'מה המספר של ביטוח לאומי');
  assert.equal(ctx2.choose('מה המספר של בעל פגי','מה המספר של בעל פגי',vocab),'מה המספר של בנק פאגי');
});

test('garbled Super-Pharm and Discount are corrected',()=>{
  assert.equal(context.fix('מה המספר של סוף אפרים ברעננה'),'מה המספר של סופר פארם ברעננה');
  assert.equal(context.fix('מה המספר של בנקי דישקונט'),'מה המספר של בנק דיסקונט');
  assert.equal(context.fix('סופר פארם'),'סופר פארם');
  assert.equal(context.fix('מה המספר של סוף אברהם ברעננה'),'מה המספר של סופר פארם ברעננה');
  assert.equal(context.fix('מה המספר של יוסף אברהם ברעננה'),'מה המספר של סופר פארם ברעננה');
});

test('official-site phone fallback uses only the official domain',()=>{
  const c={console,URL};vm.createContext(c);
  const a=source.indexOf('function officialDomainsForQuestion'),b=source.indexOf('function normalizePhoneCandidate');
  vm.runInContext(source.slice(a,b)+'\nglobalThis.p=officialPhoneAnswerFromSources;',c);
  const out=c.p('מה המספר של בנק דיסקונט',[{url:'https://www.discountbank.co.il/x',snippet:'ראשי *6111 נוסף 03-9439111'},{url:'https://spam.example',snippet:'*9999 050-1234567'}]);
  assert.match(out,/\*6111/);assert.match(out,/03-9439111/);
  assert.doesNotMatch(out,/9999|1234567/);
  assert.equal(c.p('מה המספר של בנק דיסקונט',[{url:'https://spam.example',snippet:'*9999'}]),'');
});
