import test from 'node:test';
import assert from 'node:assert/strict';
import {parseWeeklyHours,buildOpenNowAnswer} from '../business-hours.js';

const TEXT='שעות פתיחה של סניף דואר ישראל ברעננה (אופסטרלנד 4, סניף 695): ראשון: 08:00 18:00 שני: 08:00 15:00 שלישי: 08:00 18:00 רביעי: 08:00 15:00 חמישי: 08:00 15:00 שישי: סגור שבת: סגור';
test('weekly hours are parsed per day',()=>{
  const w=parseWeeklyHours(TEXT);
  assert.deepEqual(w[0],[[480,1080]]);
  assert.deepEqual(w[3],[[480,900]]);
  assert.deepEqual(w[5],[]);
  assert.equal(parseWeeklyHours('שני סניפים בעיר: 08:00 18:00'),null);
});
test('open-now answer follows Israel time',()=>{
  const w=parseWeeklyHours(TEXT);
  // Wednesday 2026-10-28 01:03 Israel (UTC+2) -> closed, opens today 08:00-15:00
  assert.match(buildOpenNowAnswer(w,'הדואר',new Date('2026-10-27T23:03:00Z')),/סגור כרגע.*רביעי.*08:00.*15:00/);
  // Wednesday 10:00 -> open until 15:00
  assert.match(buildOpenNowAnswer(w,'הדואר',new Date('2026-10-28T08:00:00Z')),/פתוח כרגע.*15:00/);
  // Wednesday 16:00 -> closed, next opening Thursday (tomorrow) 08:00
  assert.match(buildOpenNowAnswer(w,'הדואר',new Date('2026-10-28T14:00:00Z')),/סגור.*מחר.*08:00/);
  // Friday 10:00 -> closed, next Sunday
  assert.match(buildOpenNowAnswer(w,'הדואר',new Date('2026-10-30T08:00:00Z')),/ביום ראשון.*08:00/);
});
