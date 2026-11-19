// Owner, 19.11: everyday live questions — open now, buses and roads, the
// latest upload of a channel, where to buy, phone numbers.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { openState, openLine } from '../opening-hours.js';
import { nearbyFacts, businessHours, clearPlaceCache, clearTileCache, spokenTime } from '../place-tools.js';
import { busTrips, carRoute, travelFacts, clearTravelCache } from '../travel-tools.js';
import { heuristicPlan, ownerChannel, channelUploads, ext3Turn } from '../ext3-brain.js';

const json = (v, status = 200) => ({ ok: status < 400, status, json: async () => v, text: async () => JSON.stringify(v) });
const quiet = { info() {}, warn() {} };
const THU_2030 = new Date('2026-11-19T20:30:00+02:00');

test('opening hours: open now, closed now, past midnight, Friday and Shabbat', () => {
  const h = 'Su-Th 08:00-22:00; Fr 08:00-14:00; Sa off';
  assert.equal(openState(h, THU_2030).state, 'open');
  assert.equal(openState(h, THU_2030).until, '22:00');
  const late = openState(h, new Date('2026-11-19T22:30:00+02:00'));
  assert.equal(late.state, 'closed'); assert.equal(late.opensDay, 'מחר');
  const fri = openState(h, new Date('2026-11-20T15:00:00+02:00'));
  assert.equal(fri.state, 'closed'); assert.equal(fri.opensDay, 'ביום ראשון');
  assert.equal(openState('Mo-Su 19:00-02:00', new Date('2026-11-19T01:00:00+02:00')).state, 'open');
  assert.equal(openState('24/7', THU_2030).state, 'open');
  assert.equal(openState('Mo-Fr 09:00-sunset', THU_2030).state, 'unknown');
  assert.match(openLine(h, THU_2030, spokenTime), /פתוח עכשיו, עד עשר/);
});

function tiles(rows) {
  const dir = mkdtempSync(tmpdir() + '/tiles-');
  const by = new Map();
  for (const r of rows) { const k = Math.floor(r[0] * 20) + '_' + Math.floor(r[1] * 20); by.set(k, [...(by.get(k) || []), JSON.stringify(r)]); }
  for (const [k, v] of by) writeFileSync(dir + '/' + k + '.jsonl', v.join('\n'));
  process.env.OSM_TILES = dir; clearTileCache(); clearPlaceCache();
  return () => { delete process.env.OSM_TILES; clearTileCache(); clearPlaceCache(); };
}
const nominatim = places => async url => {
  const u = String(url);
  if (u.includes('/search')) { const q = new URL(u).searchParams.get('q'); const hit = places.find(p => p.match.test(q)); return json(hit ? [{ lat: String(hit.lat), lon: String(hit.lon), name: hit.name, display_name: hit.name + ', ' + hit.town + ', ישראל', address: { city: hit.town } }] : []); }
  if (u.includes('/reverse')) return json({ address: {} });
  if (u.includes('interpreter')) return json({ remark: 'busy' }, 502);
  return json({}, 404);
};

test('a pharmacy open now near Rama A in Beit Shemesh: open ones first, closed ones left out', async () => {
  const done = tiles([
    [31.7120, 34.9930, 'סופר פארם', { amenity: 'pharmacy', opening_hours: 'Su-Th 08:00-23:00; Fr 08:00-14:00; Sa off' }],
    [31.7101, 34.9905, 'בית מרקחת השכונה', { amenity: 'pharmacy', opening_hours: 'Su-Th 08:00-19:00' }],
    [31.7110, 34.9910, 'פארם נחל', { amenity: 'pharmacy' }]
  ]);
  const fetchImpl = nominatim([{ match: /רמת בית שמש א/, lat: 31.7105, lon: 34.9900, name: 'רמת בית שמש א', town: 'בית שמש' }]);
  const f = await nearbyFacts({ kindText: 'בית מרקחת שפתוחה עכשיו', place: 'רמה א', town: 'בית שמש' }, { fetchImpl, log: quiet, now: THU_2030 });
  done();
  assert.equal(f.loc.label, 'רמת בית שמש א');
  assert.equal(f.items[0].name, 'סופר פארם');
  assert.ok(!f.items.some(x => x.name === 'בית מרקחת השכונה'), 'closed one left out');
  assert.match(f.text, /פתוח עכשיו, עד אחת עשרה/);
  assert.match(f.text, /שעות הפתיחה לא מופיעות במפה/);
});

test('a named business: Rami Levy near the Hasdera mall, with its hours worked out now', async () => {
  const done = tiles([
    [31.7460, 34.9880, 'קניון השדרה', { shop: 'mall' }],
    [31.7462, 34.9882, 'רמי לוי שיווק השקמה', { shop: 'supermarket', opening_hours: 'Su-We 07:00-23:00; Th 07:00-24:00; Fr 07:00-15:00; Sa off', phone: '02-1234567' }],
    [31.7800, 35.0000, 'רמי לוי', { shop: 'supermarket' }]
  ]);
  const fetchImpl = nominatim([{ match: /^קניון השדרה/, lat: 31.7460, lon: 34.9880, name: 'קניון השדרה', town: 'בית שמש' }, { match: /^בית שמש$/, lat: 31.75, lon: 34.99, name: 'בית שמש', town: 'בית שמש' }]);
  const b = await businessHours({ name: 'רמי לוי', place: 'קניון השדרה', town: 'בית שמש' }, { fetchImpl, log: quiet, now: THU_2030 });
  done();
  assert.equal(b.items[0].name, 'רמי לוי שיווק השקמה');
  assert.match(b.text, /פתוח עכשיו, עד שתים עשרה בלילה|פתוח עכשיו, עד/);
  assert.match(b.text, /02-1234567/);
});

const stops = [
  { id: 1, code: 11, lat: 31.7106, lon: 34.9902, name: 'נחל דולב/נחל הקישון', city: 'בית שמש' },
  { id: 2, code: 12, lat: 31.7500, lon: 34.9900, name: 'מרכז העיר', city: 'בית שמש' },
  { id: 3, code: 13, lat: 31.7890, lon: 35.2030, name: 'התחנה המרכזית ירושלים', city: 'ירושלים' }
];
const ride = (rideId, stopId, stopName, seq, iso, line = '417', agency = 'בית שמש אקספרס') => ({ gtfs_ride_id: rideId, gtfs_stop_id: stopId, gtfs_stop__name: stopName, stop_sequence: seq, arrival_time: iso, departure_time: iso, pickup_type: 0, drop_off_type: 0, gtfs_route__route_short_name: line, gtfs_route__agency_name: agency, gtfs_route__route_long_name: 'x', gtfs_route__route_type: '3' });
function stride(url) {
  const u = new URL(String(url));
  if (u.pathname === '/gtfs_stops/list') return json(stops.filter(s => s.city === u.searchParams.get('city')));
  if (u.pathname === '/gtfs_ride_stops/list') {
    const ids = u.searchParams.get('gtfs_stop_ids').split(',').map(Number);
    const all = [
      ride(100, 1, 'נחל דולב/נחל הקישון', 3, '2026-11-19T18:40:00Z'), ride(100, 3, 'התחנה המרכזית ירושלים', 30, '2026-11-19T19:25:00Z'),
      ride(200, 1, 'נחל דולב/נחל הקישון', 5, '2026-11-19T18:50:00Z', '23', 'אחר'), ride(200, 2, 'מרכז העיר', 9, '2026-11-19T19:00:00Z', '23', 'אחר'),
      ride(300, 3, 'התחנה המרכזית ירושלים', 2, '2026-11-19T18:45:00Z', '418'), ride(300, 1, 'נחל דולב/נחל הקישון', 20, '2026-11-19T19:30:00Z', '418')
    ];
    const rides = u.searchParams.get('gtfs_ride_ids')?.split(',').map(Number);
    return json(all.filter(r => ids.includes(r.gtfs_stop_id) && (!rides || rides.includes(r.gtfs_ride_id))));
  }
  return json([], 404);
}

test('bus: only lines that really go from near him to near where he is going, in that direction, with times', async () => {
  clearTravelCache();
  const r = await busTrips({ lat: 31.7105, lon: 34.9900, town: 'בית שמש', label: 'רמת בית שמש א' }, { lat: 31.7891, lon: 35.2031, town: 'ירושלים', label: 'התחנה המרכזית' }, { fetchImpl: async u => stride(u), now: new Date('2026-11-19T18:30:00Z') });
  assert.equal(r.trips.length, 1, 'line 23 does not reach Jerusalem, 418 goes the other way');
  assert.equal(r.trips[0].line, '417');
  assert.equal(r.trips[0].leaves, '20:40');
  assert.equal(r.trips[0].arrives, '21:25');
});

test('car: the roads in order, with the usual time, from the map router', async () => {
  clearTravelCache();
  const osrm = { code: 'Ok', routes: [{ distance: 31780, duration: 1940, legs: [{ steps: [
    { name: 'הגפן', distance: 129 }, { name: '', ref: '38', distance: 7543 }, { name: '', ref: '38', distance: 400 },
    { name: 'כביש ירושלים תל אביב', ref: '1', distance: 11894 }, { name: 'דרך אריאל שרון', ref: '16', distance: 5294 }, { name: 'הפלמ"ח', distance: 248 }] }] }] };
  const c = await carRoute({ lat: 31.7466, lon: 34.9895 }, { lat: 31.7683, lon: 35.2137 }, { fetchImpl: async () => json(osrm) });
  assert.deepEqual(c.best.roads.map(r => r.label), ['כביש 38', 'כביש 1 (כביש ירושלים תל אביב)', 'כביש 16 (דרך אריאל שרון)']);
  assert.equal(c.best.minutes, 32);
});

test('travel facts: both ends found, bus and car together, honest about live traffic', async () => {
  clearTravelCache(); clearPlaceCache();
  const fetchImpl = async url => {
    const u = String(url);
    if (u.includes('stride')) return stride(u);
    if (u.includes('osrm')) return json({ code: 'Ok', routes: [{ distance: 31000, duration: 1900, legs: [{ steps: [{ ref: '38', distance: 8000 }, { ref: '1', distance: 12000, name: 'כביש ירושלים תל אביב' }] }] }] });
    return nominatim([{ match: /רמת בית שמש א/, lat: 31.7105, lon: 34.99, name: 'רמת בית שמש א', town: 'בית שמש' }, { match: /התחנה המרכזית/, lat: 31.7891, lon: 35.2031, name: 'התחנה המרכזית', town: 'ירושלים' }])(u);
  };
  const f = await travelFacts({ from: { place: 'רמה א', town: 'בית שמש' }, to: { place: 'התחנה המרכזית', town: 'ירושלים' } }, { fetchImpl, log: quiet, now: new Date('2026-11-19T18:30:00Z') });
  assert.match(f.text, /קו 417 של בית שמש אקספרס/);
  assert.match(f.text, /כביש 38, כביש 1/);
  assert.match(f.text, /בלי נתוני עומסים חיים/);
  assert.deepEqual(f.roads, ['38', '1']);
});

test('the brain answers a route question from the real data, and asks where he leaves from when missing', async () => {
  const planned = plan => async prompt => /אתה המתכנן/.test(prompt) ? JSON.stringify(plan) : 'ANSWER:' + (prompt.match(/קו \d+/) || [''])[0];
  const r = await ext3Turn({ utterance: 'אני ברמה א בבית שמש איך אני מגיע באוטובוס לתחנה המרכזית בירושלים', now: 'x' }, {
    llm: planned({ intent: 'route', standalone: 'x', from_place: 'רמה א', from_town: 'בית שמש', to_place: 'התחנה המרכזית', to_town: 'ירושלים', mode: 'bus' }), log: quiet,
    travelFacts: async () => ({ text: 'נתונים\n1. קו 417 של בית שמש אקספרס', bus: { trips: [{}] }, car: null, roads: [] })
  });
  assert.equal(r.intent, 'route');
  assert.match(r.reply, /קו 417/);
  const ask = await ext3Turn({ utterance: 'איך אני מגיע לכותל', now: 'x' }, { llm: planned({ intent: 'route', standalone: 'x', to_place: 'הכותל', to_town: 'ירושלים' }), log: quiet });
  assert.match(ask.reply, /מאיפה אתה יוצא/);
});

test('"the latest lesson of X on YouTube" is a newest-video search, and the channel itself is found', async () => {
  assert.equal(heuristicPlan('מה השיעור האחרון של גואל אלקריף ביוטיוב').intent, 'video_find');
  assert.equal(heuristicPlan('מה השיעור האחרון של גואל אלקריף ביוטיוב').order, 'date');
  assert.equal(heuristicPlan('איזה סרטונים יצאו לאחרונה בערוץ 14').intent, 'video_find');
  const found = [
    { videoId: 'a'.repeat(11), channelId: 'UC' + 'x'.repeat(22), channelTitle: 'גואל אלקריף - הערוץ הרשמי' },
    { videoId: 'b'.repeat(11), channelId: 'UC' + 'y'.repeat(22), channelTitle: 'קטעים נבחרים' }
  ];
  assert.equal(ownerChannel(found, 'השיעור האחרון של גואל אלקריף').id, 'UC' + 'x'.repeat(22));
  assert.equal(ownerChannel([{ videoId: 'c'.repeat(11), channelId: 'UC' + 'z'.repeat(22), channelTitle: 'ערוץ אחר' }], 'גואל אלקריף'), null);
  // The channel's own uploads page, newest first, with dates from yt-dlp when there is no API quota.
  const execImpl = async args => {
    const url = args[args.length - 1];
    if (url.endsWith('/videos')) return JSON.stringify({ entries: [{ id: 'n'.repeat(11), title: 'שיעור חדש' }, { id: 'o'.repeat(11), title: 'שיעור קודם' }] });
    if (url.endsWith('/streams')) return JSON.stringify({ entries: [] });
    const id = url.split('v=')[1];
    return JSON.stringify({ id, title: id[0] === 'n' ? 'שיעור חדש' : 'שיעור קודם', upload_date: id[0] === 'n' ? '20261118' : '20261110', duration: 3600, channel: 'גואל אלקריף' });
  };
  const ups = await channelUploads('UC' + 'x'.repeat(22), { execImpl, fetchImpl: async () => json({ error: { code: 403 } }, 403), env: {} });
  assert.equal(ups[0].title, 'שיעור חדש');
  assert.equal(ups[0].publishedAt.slice(0, 10), '2026-11-18');
});

test('where to buy, phone numbers and "open now" go to the web, not to memory', () => {
  for (const q of ['איפה מוכרים את הספר נפש החיים בבית שמש', 'מה המספר של הרב דביר בעניין מכונות תספורת', 'האם רמי לוי בבית שמש בקניון השדרה פתוח עכשיו'])
    assert.equal(heuristicPlan(q).intent, 'web', q);
});
