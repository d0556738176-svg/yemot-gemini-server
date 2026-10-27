import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';

const source=readFileSync(new URL('../server.js',import.meta.url),'utf8');
const a=source.indexOf('function groundedValidator'),b=source.indexOf('// When search snippets lack the requested detail');
const ctx={};vm.createContext(ctx);
vm.runInContext(source.slice(a,b)+'\nglobalThis.v=groundedValidator;',ctx);

test('answers with numbers absent from the evidence are rejected',()=>{
  const ok=ctx.v('ראשי *6111 נוסף 03-9439111. פתוח 08:00 עד 15:00');
  assert.equal(ok('המספר הוא *6111'),true);
  assert.equal(ok('המספר הוא 03 9439111'),true);
  assert.equal(ok('המספר הוא *6112'),false);
  assert.equal(ok('התקשר ל-03-1234567'),false);
  assert.equal(ok('פתוח מ-08:00 עד 15:00'),true);
  assert.equal(ok('פתוח עד 18:00'),false);
  assert.equal(ok('אין לי מידע על זה'),true);
});
