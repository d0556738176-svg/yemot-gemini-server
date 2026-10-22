import test from 'node:test';
import assert from 'node:assert/strict';
import { buildBusinessHoursQueries, buildBusinessHoursFallback, isBusinessHoursQuestion } from './business-hours.js';

test('routes speech transcription variant of Super-Pharm to the official domain',()=>{
  const question='מה שעות הפתיחה של סופר אפרים בקניון עזריאלי בתל אביב בכל יום בשבוע';
  assert.equal(isBusinessHoursQuestion(question),true);
  const queries=buildBusinessHoursQueries({targets:['סופר-פארם'],locationText:'קניון עזריאלי תל אביב',city:'תל אביב',area:'קניון עזריאלי',question});
  assert.ok(queries.some(q=>q.includes('super-pharm.co.il')));
});

test('official branch hours can be returned without model synthesis',()=>{
  const answer=buildBusinessHoursFallback({
    question:'מה שעות הפתיחה של סופר אפרים בקניון עזריאלי בתל אביב בכל יום בשבוע',
    business:'סופר-פארם',city:'תל אביב',area:'קניון עזריאלי',locationText:'קניון עזריאלי תל אביב',
    results:[{title:'סופר-פארם קניון עזריאלי ת״א',url:'https://shop.super-pharm.co.il/branches/branchPage?code=61',snippet:"א'-ה': 08:00-22:30 שישי: 08:00-16:00 שבת: 20:00-23:00"}]
  });
  assert.match(answer,/08:00-22:30/);
  assert.match(answer,/08:00-16:00/);
  assert.match(answer,/20:00-23:00/);
  assert.match(answer,/יום ראשון: 08:00-22:30/);
  assert.match(answer,/יום שישי: 08:00-16:00/);
  assert.match(answer,/יום שבת: 20:00-23:00/);
});


test('generic official business schedule is parsed day by day without Super-Pharm special casing',()=>{
  const answer=buildBusinessHoursFallback({
    question:'מה שעות הפתיחה של בנק דיסקונט בסניף מרכז העיר בתל אביב לכל יום בשבוע',
    business:'בנק דיסקונט',city:'תל אביב',area:'מרכז העיר',locationText:'מרכז העיר תל אביב',
    results:[{title:'בנק דיסקונט - מרכז העיר',url:'https://www.discountbank.co.il/branches/center',
      snippet:"מרכז העיר תל אביב. יום ראשון: 09:00-15:00 יום שני: 09:00-18:00 יום שלישי: 09:00-15:00 יום רביעי: 09:00-18:00 יום חמישי: 09:00-15:00 יום שישי: 08:30-12:00 שבת: 00:00-00:00"}]
  });
  assert.match(answer,/האתר הרשמי של בנק דיסקונט/);
  assert.match(answer,/יום ראשון: 09:00-15:00/);
  assert.match(answer,/יום שני: 09:00-18:00/);
  assert.match(answer,/יום שישי: 08:30-12:00/);
});
