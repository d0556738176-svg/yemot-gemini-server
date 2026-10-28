import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
const source=readFileSync(new URL('../server.js',import.meta.url),'utf8');
const refresh=source.slice(source.indexOf('async function refreshCallerMemory'),source.indexOf('async function persistConversationEntry'));
function setup(rows, initial=[]){
  const context={URLSearchParams,AbortSignal,SUPABASE_ENABLED:true,MAX_CONVERSATION_LOG:1000,conversationLog:initial,
    normalizePhone:x=>String(x).replace(/^\+?972/,'0'),geminiErrorStatus:()=>0,console:{info(){},warn(){}},
    supabaseRequest:async(url,options)=>{context.query=url;assert.ok(options.signal);return {json:async()=>rows};}};
  vm.createContext(context);vm.runInContext(refresh+';globalThis.run=refreshCallerMemory;',context);return context;
}
test('returning caller loads older durable history even when absent from startup cache',async()=>{
  const c=setup([{id:42,phone:'0501234567',created_at:'2026-10-27T10:00:00Z',call_id:'old',user_text:'איזה מופע בבית שמש מחר',gemini_text:'תשובה'}]);
  await c.run('0501234567');assert.equal(c.conversationLog[0].user,'איזה מופע בבית שמש מחר');assert.match(decodeURIComponent(c.query),/phone.eq.0501234567/);
});
test('memory refresh excludes another caller even if response contains their row',async()=>{
 const c=setup([{id:1,phone:'0507654321',user_text:'private'}]);await c.run('0501234567');assert.equal(c.conversationLog.length,0);
});
test('repeated caller refresh does not duplicate the live cached turn',async()=>{
 const entry={id:'local',phone:'0501234567',time:'2026-10-27',callId:'same',user:'ומחר',resolvedQuestion:'מופע בבית שמש מחר',gemini:'answer'};
 const c=setup([{id:88,phone:'0501234567',created_at:'2026-10-27',call_id:'same',user_text:entry.resolvedQuestion,gemini_text:'answer'}],[entry]);
 await c.run(entry.phone);assert.equal(c.conversationLog.length,1);
});
test('unidentified caller never loads shared history',async()=>{
 const c=setup([]);await c.run('לא מזוהה');assert.equal(c.query,undefined);
});
