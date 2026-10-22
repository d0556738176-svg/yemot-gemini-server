import test from 'node:test';
import assert from 'node:assert/strict';
import { buildBusinessHoursQueries, buildBusinessHoursFallback } from '../business-hours.js';

test('Super-Pharm at BIG triggers targeted official-source queries', () => {
  const queries = buildBusinessHoursQueries({
    targets: ['סופר-פארם'],
    locationText: 'ביג',
    city: '',
    area: 'ביג',
    pharmacy: true,
    question: 'מתי סופר פארם בביג מתי פתוח'
  });
  assert.ok(queries.some(q => q.includes('site:super-pharm.co.il')));
  assert.ok(queries.some(q => /BIG|ביג/i.test(q)));
  assert.ok(queries.length <= 8);
});

test('ambiguous BIG location asks for city instead of guessing a branch', () => {
  const answer = buildBusinessHoursFallback({
    question: 'מתי סופר פארם בביג מתי פתוח',
    business: 'סופר-פארם',
    area: 'ביג',
    locationText: 'ביג',
    results: [{title:'סופר-פארם BIG',url:'https://www.super-pharm.co.il/',snippet:'שעות פתיחה'}]
  });
  assert.match(answer, /באיזו עיר/);
  assert.doesNotMatch(answer, /09:00|22:00/);
});

test('official matching branch hours are returned without Gemini availability', () => {
  const answer = buildBusinessHoursFallback({
    question: 'מתי סופר פארם בביג בית שמש פתוח',
    business: 'סופר-פארם',
    city: 'בית שמש',
    area: 'ביג',
    locationText: 'ביג בית שמש',
    results: [{
      title:'סופר-פארם BIG בית שמש',
      url:'https://www.super-pharm.co.il/branches/123',
      snippet:'שעות פתיחה א׳-ה׳ 09:00-22:00, ו׳ 08:00-14:00'
    }]
  });
  assert.match(answer, /09:00-22:00/);
  assert.match(answer, /אתר הרשמי/);
});

test('does not invent hours when source lacks a schedule', () => {
  const answer = buildBusinessHoursFallback({
    question:'מתי סופר פארם בנתניה פתוח',
    business:'סופר-פארם',
    city:'נתניה',
    locationText:'נתניה',
    results:[{title:'סופר-פארם נתניה',url:'https://www.super-pharm.co.il/branches/123',snippet:'כתובת הסניף בנתניה'}]
  });
  assert.match(answer, /לא נמצאו שעות פתיחה ברורות/);
  assert.doesNotMatch(answer, /09:00|22:00/);
});


test('richest matching official result wins over generic official result', () => {
  const answer = buildBusinessHoursFallback({
    question:'מה שעות הפתיחה של בנק דיסקונט בסניף מרכז העיר לכל יום בשבוע',
    business:'בנק דיסקונט',
    city:'תל אביב',
    area:'מרכז העיר',
    locationText:'מרכז העיר תל אביב',
    results:[
      {title:'בנק דיסקונט מרכז העיר',url:'https://www.discountbank.co.il/branches',snippet:'שעות פעילות 09:00-14:00'},
      {title:'בנק דיסקונט מרכז העיר תל אביב',url:'https://www.discountbank.co.il/branches/61',snippet:"א'-ה': 08:00-18:30 שישי: 08:00-13:00"}
    ]
  });
  assert.match(answer,/08:00-18:30/);
});
