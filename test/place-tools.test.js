import { test } from 'node:test';
import assert from 'node:assert/strict';
import { clearPlaceCache, geocode, zmanimFacts, nearbyFacts, spokenTime, resolveDate, localZmanim, isZmanimQuestion, isNearbyQuestion } from '../place-tools.js';
import { ext3Turn, placeFromText, heuristicPlan, zmanReply } from '../ext3-brain.js';

const HEBCAL = { times: { alotHaShachar: '2026-11-18T04:56:00+02:00', misheyakir: '2026-11-18T05:19:00+02:00', sunrise: '2026-11-18T06:12:00+02:00', sofZmanShmaMGA: '2026-11-18T08:13:00+02:00', sofZmanShma: '2026-11-18T08:49:00+02:00', sofZmanTfillaMGA: '2026-11-18T09:17:00+02:00', sofZmanTfilla: '2026-11-18T09:41:00+02:00', chatzot: '2026-11-18T11:26:00+02:00', sunset: '2026-11-18T16:41:00+02:00', tzeit7083deg: '2026-11-18T17:12:00+02:00', tzeit85deg: '2026-11-18T17:19:00+02:00', tzeit72min: '2026-11-18T17:53:00+02:00' } };
const json = (j, status = 200) => ({ ok: status < 400, status, json: async () => j, text: async () => JSON.stringify(j) });
// Ashdod's separate beach first, as Nominatim really answered on 18.11.
function fakeFetch(log = []) {
  clearPlaceCache();
  return async (url, opts = {}) => {
    const u = String(url); log.push(u);
    if (u.includes('nominatim') && u.includes('/search')) {
      const q = new URL(u).searchParams.get('q');
      if (/נפרד/.test(q)) return json([{ lat: '31.79', lon: '34.62', name: 'החוף הנפרד אשדוד', display_name: 'החוף הנפרד אשדוד, אשדוד, נפת אשקלון, מחוז הדרום, ישראל', address: { city: 'אשדוד' }, boundingbox: [] }]);
      if (/אשקלון/.test(q)) return json([{ lat: '31.66', lon: '34.57', name: 'אשקלון', display_name: 'אשקלון, נפת אשקלון, מחוז הדרום, ישראל', address: { city: 'אשקלון' }, boundingbox: ['31.60', '31.72', '34.52', '34.62'] }]);
      if (/עוצם/.test(q)) return json([{ lat: '31.6366', lon: '34.7026', name: 'עוצם', display_name: 'עוצם, מועצה אזורית לכיש, נפת אשקלון, מחוז הדרום, ישראל', address: { village: 'עוצם' }, boundingbox: [] }]);
      return json([]);
    }
    if (u.includes('nominatim') && u.includes('/reverse')) return json({ address: { road: 'שדרות בן גוריון', house_number: '5', city: 'אשקלון' } });
    if (u.includes('hebcal')) return json(HEBCAL);
    if (u.includes('interpreter')) {
      const body = decodeURIComponent(String(opts.body || ''));
      if (/name"~"נפרד/.test(body)) return json({ elements: [{ type: 'way', center: { lat: 31.6801, lon: 34.5560 }, tags: { name: 'החוף הנפרד', natural: 'beach' } }] });
      if (/place_of_worship/.test(body)) return json({ elements: [
        { type: 'node', lat: 31.6900, lon: 34.5700, tags: { amenity: 'place_of_worship', religion: 'jewish', name: 'בית כנסת רחוק' } },
        { type: 'node', lat: 31.6805, lon: 34.5590, tags: { amenity: 'place_of_worship', religion: 'jewish', name: 'בית כנסת חוף הים', 'addr:street': 'הרב קוק', 'addr:housenumber': '3' } },
        { type: 'node', lat: 31.6830, lon: 34.5620, tags: { amenity: 'place_of_worship', religion: 'jewish' } }] });
      return json({ elements: [] });
    }
    return json({}, 404);
  };
}

test('spoken times are words, not 8:49', () => {
  assert.equal(spokenTime('08:49'), 'שמונה וארבעים ותשע דקות בבוקר');
  assert.equal(spokenTime('16:41'), 'ארבע וארבעים ואחת דקות אחר הצהריים');
  assert.equal(spokenTime('17:00'), 'חמש בדיוק אחר הצהריים');
});

test('dates from his words', () => {
  const now = new Date('2026-11-18T10:00:00Z'); // Wednesday
  assert.equal(resolveDate('היום', '', now), '2026-11-18');
  assert.equal(resolveDate('מחר', '', now), '2026-11-19');
  assert.equal(resolveDate('במוצאי שבת', '', now), '2026-11-21');
  assert.equal(resolveDate('הדלקת נרות', '', now), '2026-11-20');
});

test('the local calculation is within a few minutes of Hebcal', () => {
  const z = localZmanim(31.6366, 34.7026, '2026-11-18');
  const min = t => Number(t.split(':')[0]) * 60 + Number(t.split(':')[1]);
  assert.ok(Math.abs(min(z.sunrise) - min('06:12')) <= 3, z.sunrise);
  assert.ok(Math.abs(min(z.sofZmanShma) - min('08:49')) <= 3, z.sofZmanShma);
  assert.ok(Math.abs(min(z.sunset) - min('16:41')) <= 3, z.sunset);
});

test('a landmark is found in the town he said, not in another town', async () => {
  const loc = await geocode({ place: 'החוף הנפרד', town: 'אשקלון' }, { fetchImpl: fakeFetch(), log: { warn() {} } });
  assert.equal(loc.label, 'החוף הנפרד');
  assert.ok(Math.abs(loc.lat - 31.6801) < 0.001, 'Ashkelon, not Ashdod');
});

test('his words: questions and places', () => {
  assert.ok(isZmanimQuestion('מתי סוף זמן קריאת שמע של הגרא במשוב עוצם'));
  assert.ok(isNearbyQuestion('איפה הבית כנסת הקרוב ביותר לחוף הנפרד באשקלון'));
  assert.deepEqual(placeFromText('מתי סוף זמן קריאת שמע של הגרא במשוב עוצם'), { place: '', town: 'עוצם' });
  assert.deepEqual(placeFromText('איפה הבית כנסת הקרוב ביותר לחוף הנפרד באשקלון'), { place: 'חוף הנפרד', town: 'אשקלון' });
  assert.deepEqual(placeFromText('מתי צאת השבת בבני ברק'), { place: '', town: 'בני ברק' });
  assert.equal(heuristicPlan('מה השקיעה היום בבית שמש').intent, 'zmanim');
});

test('Shema of the GRA in moshav Otzem: the computed time, said in words', async () => {
  const now = new Date('2026-11-18T05:00:00Z');
  const r = await ext3Turn({ utterance: 'מתי סוף זמן קריאת שמע של הגרא במשוב עוצם', now: 'יום רביעי', voice: 'male', brief: true }, {
    llm: async () => { throw Object.assign(new Error('busy'), { status: 503 }); }, fetchImpl: fakeFetch(), nowDate: now, log: { info() {}, warn() {} }, webSearch: async () => []
  });
  assert.equal(r.intent, 'zmanim');
  assert.match(r.reply, /לפי הגר״א בעוצם היום הוא בשמונה וארבעים ותשע דקות בבוקר/);
  assert.match(r.reply, /המגן אברהם.*שמונה ושלוש עשרה דקות/);
});

test('the nearest synagogue to the separate beach of Ashkelon: nearest first, from the map', async () => {
  const facts = await nearbyFacts({ kindText: 'בית כנסת', place: 'החוף הנפרד', town: 'אשקלון' }, { fetchImpl: fakeFetch(), log: { warn() {} } });
  assert.equal(facts.items[0].name, 'בית כנסת חוף הים');
  assert.match(facts.text, /הרב קוק 3/);
  const r = await ext3Turn({ utterance: 'איפה הבית כנסת הקרוב ביותר לחוף הנפרד באשקלון', now: 'יום רביעי' }, {
    llm: async () => { throw Object.assign(new Error('busy'), { status: 503 }); }, fetchImpl: fakeFetch(), log: { info() {}, warn() {} }, webSearch: async () => [], retryPauseMs: 0
  });
  assert.equal(r.intent, 'nearby');
  assert.match(r.reply, /הקרוב ביותר לחוף הנפרד הוא בית כנסת חוף הים, במרחק \d+ מטר, ברחוב הרב קוק 3/);
});

test('a general request for the times goes to the model, a single time does not', () => {
  const facts = { times: { sunset: '16:41' }, loc: { label: 'ירושלים', town: 'ירושלים' }, when: 'היום', text: '' };
  assert.equal(zmanReply(facts, 'מה זמני היום בירושלים'), null);
  assert.match(zmanReply(facts, 'מתי השקיעה בירושלים'), /השקיעה בירושלים היום בארבע וארבעים ואחת/);
});
