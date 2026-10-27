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
