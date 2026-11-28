import test from 'node:test';
import assert from 'node:assert/strict';
import { parseDayHours, parseWeek, openStateNow, mapsBusinessHours } from '../maps-hours.js';

test('day hours in Google formats', () => {
  assert.deepEqual(parseDayHours('7 AM–11 PM'), [[420, 1380]]);
  assert.deepEqual(parseDayHours('07:00–23:00'), [[420, 1380]]);
  assert.deepEqual(parseDayHours('8:30 AM–1 PM, 4–7 PM'), [[510, 780], [960, 1140]]);
  assert.deepEqual(parseDayHours('Closed'), []);
  assert.deepEqual(parseDayHours('סגור'), []);
  assert.deepEqual(parseDayHours('Open 24 hours'), [[0, 1440]]);
  assert.deepEqual(parseDayHours('8 PM–1 AM'), [[1200, 1500]]);
});

const week = parseWeek({ Sunday: '7 AM–11 PM', Monday: '7 AM–11 PM', Tuesday: '7 AM–11 PM', Wednesday: '7 AM–11 PM', Thursday: '7 AM–12 AM', Friday: '7 AM–2:30 PM', Saturday: '7:30 PM–11 PM' });
// 2026-11-28 is a Saturday; Israel is UTC+2 in winter.
test('Saturday night after Shabbat: open', () => {
  const st = openStateNow(week, new Date('2026-11-28T18:00:00Z')); // 20:00
  assert.equal(st.state, 'open'); assert.equal(st.until, 1380);
});
test('Saturday afternoon: closed, opens tonight', () => {
  const st = openStateNow(week, new Date('2026-11-28T12:00:00Z')); // 14:00
  assert.equal(st.state, 'closed'); assert.equal(st.opensDay, 'היום'); assert.equal(st.opensAt, 1170);
});
test('Friday evening: closed, opens Saturday night', () => {
  const st = openStateNow(week, new Date('2026-11-27T15:00:00Z')); // Fri 17:00
  assert.equal(st.state, 'closed'); assert.equal(st.opensDay, 'מחר'); assert.equal(st.opensAt, 1170);
});
test('Hebrew day names', () => {
  const w = parseWeek({ 'יום ראשון': '7:00–23:00', 'שבת': 'סגור' });
  assert.deepEqual(w[0], [[420, 1380]]); assert.deepEqual(w[6], []);
});
test('picks the branch in the town and mall he named', async () => {
  const fetchImpl = async () => ({ ok: true, json: async () => ({ places: [
    { title: 'רמי לוי שיווק השיקמה', address: 'יגאל אלון 1, ירושלים', openingHours: { Saturday: '8 PM–11 PM' } },
    { title: 'רמי לוי', address: 'קניון השדרה, שדרות יגאל אלון, בית שמש', phoneNumber: '02-0000000', openingHours: { Saturday: '7:30 PM–11 PM' } }
  ] }) });
  const r = await mapsBusinessHours({ name: 'רמי לוי', place: 'קניון השדרה', town: 'בית שמש' }, { keys: ['k'], fetchImpl, log: {}, now: new Date('2026-11-28T18:00:00Z') });
  assert.equal(r.found, true); assert.match(r.place.address, /בית שמש/); assert.equal(r.state.state, 'open');
  assert.match(r.text, /פתוח עכשיו/);
});
test('a mall he named that no listing mentions: not another branch', async () => {
  const fetchImpl = async () => ({ ok: true, json: async () => ({ places: [{ title: 'סופר פארם גאלרי', address: 'ילדי טהרן 7, ראשון לציון', openingHours: { Saturday: '8 PM–11 PM' } }, { title: 'סופר פארם רוטשילד', address: 'רוטשילד 1, ראשון לציון' }] }) });
  const r = await mapsBusinessHours({ name: 'סופר פארם', place: 'קניון הזהב', town: 'ראשון לציון' }, { keys: ['k'], fetchImpl, log: {} });
  assert.equal(r.found, false); assert.equal(r.otherBranch, true);
});
