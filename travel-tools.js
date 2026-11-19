// Getting from place to place (owner, 19.11.2026): "I'm in X and need to get
// to Y, how do I go by bus, and by car, which roads".
// Bus: the Ministry of Transport's real timetable (GTFS) through the public
// Open Bus API of Hasadna — the lines that really leave from stops near him in
// the next hour and a half and really stop near where he is going, with times.
// Car: the OpenStreetMap router (OSRM) — the roads in order, distance and the
// usual driving time. Neither has live traffic; the answer says so honestly.
// Free, no keys. Nothing here is invented: no trip found = said plainly.
import { geocode, distanceKm, spokenDistance, spokenTime } from './place-tools.js';

const UA = 'yemot-ai-phone/1.0 (owner phone line; contact via github d0556738176-svg)';
const STRIDE = 'https://open-bus-stride-api.hasadna.org.il';
const OSRM = 'https://router.project-osrm.org';

async function getJson(url, { fetchImpl = fetch, timeoutMs = 8000 } = {}) {
  const r = await fetchImpl(url, { headers: { 'user-agent': UA, accept: 'application/json' }, signal: AbortSignal.timeout(timeoutMs) });
  if (!r.ok) throw Object.assign(new Error('HTTP ' + r.status), { status: r.status });
  return r.json();
}
const cache = new Map();
function cached(key, ms, fn) {
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < ms) return hit.p;
  const p = fn().catch(e => { cache.delete(key); throw e; });
  cache.set(key, { at: Date.now(), p });
  if (cache.size > 200) cache.delete(cache.keys().next().value);
  return p;
}
export function clearTravelCache() { cache.clear(); }

const israelDay = (d = new Date()) => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Jerusalem', year: 'numeric', month: '2-digit', day: '2-digit' }).format(d);
export const israelHHMM = iso => new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Jerusalem', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(new Date(iso));
const plainCity = s => String(s || '').replace(/[״"׳']/g, '').replace(/^(?:ה?עיר|מושב|קיבוץ)\s+/u, '').trim();

/** Today's stops of a town (the timetable's own list), cached for the day. */
export function townStops(town, { fetchImpl = fetch, now = new Date() } = {}) {
  const day = israelDay(now), city = plainCity(town);
  if (!city) return Promise.resolve([]);
  return cached('stops|' + city + '|' + day, 6 * 3600 * 1000, async () => {
    const u = new URL(STRIDE + '/gtfs_stops/list');
    u.searchParams.set('city', city); u.searchParams.set('date_from', day); u.searchParams.set('date_to', day); u.searchParams.set('limit', '5000');
    const list = await getJson(u, { fetchImpl, timeoutMs: 9000 });
    return (Array.isArray(list) ? list : []).filter(s => Number.isFinite(s.lat) && Number.isFinite(s.lon)).map(s => ({ id: s.id, code: s.code, name: s.name, lat: s.lat, lon: s.lon, city: s.city }));
  });
}
function nearest(stops, loc, maxKm = 0.6, n = 10) {
  let near = stops.map(s => ({ ...s, km: distanceKm(loc, s) })).filter(s => s.km <= maxKm);
  if (!near.length) near = stops.map(s => ({ ...s, km: distanceKm(loc, s) })).filter(s => s.km <= maxKm * 1.8);
  return near.sort((a, b) => a.km - b.km).slice(0, n);
}
async function rideStops(params, { fetchImpl }) {
  const u = new URL(STRIDE + '/gtfs_ride_stops/list');
  for (const [k, v] of Object.entries(params)) u.searchParams.set(k, String(v));
  const list = await getJson(u, { fetchImpl, timeoutMs: 10000 });
  return Array.isArray(list) ? list : [];
}

/**
 * Direct bus trips (no change of bus) from near `from` to near `to`, leaving in
 * the next `windowMin` minutes. Returns { trips, fromStops, toStops } or { error }.
 */
export async function busTrips(from, to, { fetchImpl = fetch, now = new Date(), windowMin = 90 } = {}) {
  const [fs, ts] = await Promise.all([townStops(from.town || from.label, { fetchImpl, now }), sameCity(from, to) ? null : townStops(to.town || to.label, { fetchImpl, now })]);
  const fromStops = nearest(fs, from, 0.6, 10), toStops = nearest(ts || fs, to, 0.6, 12);
  if (!fromStops.length) return { error: 'no_stops_from', fromStops, toStops };
  if (!toStops.length) return { error: 'no_stops_to', fromStops, toStops };
  const t0 = new Date(now.getTime() - 2 * 60000).toISOString(), t1 = new Date(now.getTime() + windowMin * 60000).toISOString();
  const leaving = await rideStops({ gtfs_stop_ids: fromStops.map(s => s.id).join(','), arrival_time_from: t0, arrival_time_to: t1, limit: 1500 }, { fetchImpl });
  const board = new Map();
  for (const r of leaving) {
    if (r.pickup_type === 1) continue;
    const prev = board.get(r.gtfs_ride_id);
    if (!prev || r.stop_sequence > prev.stop_sequence) board.set(r.gtfs_ride_id, r); // the stop nearest the destination on the same ride
  }
  if (!board.size) return { trips: [], fromStops, toStops, debug: { leaving: leaving.length, rides: 0, arriving: 0 } };
  // Everything arriving near the destination in the window, matched to the
  // rides above here (the API's ride filter returned nothing live, 19.11).
  const t2 = new Date(now.getTime() + (windowMin + 150) * 60000).toISOString();
  const arriving = (await rideStops({ gtfs_stop_ids: toStops.map(s => s.id).join(','), arrival_time_from: t0, arrival_time_to: t2, limit: 5000 }, { fetchImpl })).filter(r => board.has(r.gtfs_ride_id));
  const fromKm = new Map(fromStops.map(s => [s.id, s.km])), toKm = new Map(toStops.map(s => [s.id, s.km]));
  const trips = [];
  for (const a of arriving) {
    const b = board.get(a.gtfs_ride_id);
    if (!b || a.stop_sequence <= b.stop_sequence || a.drop_off_type === 1) continue;
    trips.push({
      line: String(b.gtfs_route__route_short_name || ''), agency: b.gtfs_route__agency_name || '', routeName: String(b.gtfs_route__route_long_name || '').replace(/-\d+$/, ''),
      board: b.gtfs_stop__name, boardWalkKm: fromKm.get(b.gtfs_stop_id) ?? null, leaves: israelHHMM(b.departure_time || b.arrival_time), leavesAt: Date.parse(b.departure_time || b.arrival_time),
      alight: a.gtfs_stop__name, alightWalkKm: toKm.get(a.gtfs_stop_id) ?? null, arrives: israelHHMM(a.arrival_time), arrivesAt: Date.parse(a.arrival_time),
      rail: String(b.gtfs_route__route_type) === '2'
    });
  }
  // Best per departure: the earliest arrival; at most two departures per line.
  const byRide = new Map();
  for (const t of trips) { const k = t.line + '|' + t.leaves; if (!byRide.has(k) || t.arrivesAt < byRide.get(k).arrivesAt) byRide.set(k, t); }
  const perLine = new Map(), out = [];
  for (const t of [...byRide.values()].sort((a, b) => a.arrivesAt - b.arrivesAt)) {
    const n = perLine.get(t.line) || 0;
    if (n >= 2) continue;
    perLine.set(t.line, n + 1); out.push(t);
  }
  return { trips: out.slice(0, 5), fromStops, toStops, debug: { leaving: leaving.length, rides: board.size, arriving: arriving.length, matched: trips.length } };
}
function sameCity(a, b) { return plainCity(a.town) && plainCity(a.town) === plainCity(b.town); }

/** Driving: distance, usual time and the main roads in order. */
export async function carRoute(from, to, { fetchImpl = fetch } = {}) {
  const u = OSRM + '/route/v1/driving/' + from.lon.toFixed(5) + ',' + from.lat.toFixed(5) + ';' + to.lon.toFixed(5) + ',' + to.lat.toFixed(5) + '?overview=false&steps=true&alternatives=true';
  const j = await cached('car|' + u, 15 * 60000, () => getJson(u, { fetchImpl, timeoutMs: 9000 }));
  if (j?.code !== 'Ok' || !j.routes?.length) return null;
  const describe = route => {
    const roads = [];
    for (const st of route.legs.flatMap(l => l.steps || [])) {
      const ref = String(st.ref || '').split(';')[0].trim();
      const label = ref && /^\d+$/.test(ref) ? 'כביש ' + ref + (st.name && !/^\d+$/.test(st.name) && st.name.length < 30 ? ' (' + st.name + ')' : '') : st.name || '';
      if (!label) continue;
      const last = roads[roads.length - 1];
      const key = ref || st.name;
      if (last && last.key === key) { last.km += st.distance / 1000; continue; }
      roads.push({ key, label, km: st.distance / 1000 });
    }
    const main = roads.filter(r => r.km >= 1.2 || /^כביש/.test(r.label));
    return { km: route.distance / 1000, minutes: Math.round(route.duration / 60), roads: (main.length ? main : roads).slice(0, 8).map(r => ({ label: r.label, km: Math.round(r.km * 10) / 10 })) };
  };
  return { best: describe(j.routes[0]), other: j.routes[1] ? describe(j.routes[1]) : null };
}

const spokenMin = m => m < 60 ? m + ' דקות' : Math.floor(m / 60) + ' שעות' + (m % 60 ? ' ו-' + (m % 60) + ' דקות' : '');

/**
 * Everything for the answer: geocodes both ends, then bus and/or car.
 * from/to: { place, town }. mode: 'bus' | 'car' | 'any'.
 */
export async function travelFacts({ from = {}, to = {}, mode = 'any' } = {}, { fetchImpl = fetch, log = console, now = new Date() } = {}) {
  const [a, b] = await Promise.all([geocode(from, { fetchImpl, log }).catch(() => null), geocode(to, { fetchImpl, log }).catch(() => null)]);
  if (!a || !b) return { unknown: !a ? (from.place || from.town || 'נקודת המוצא') : (to.place || to.town || 'היעד'), missing: !a ? 'from' : 'to' };
  if (!a.town) a.town = from.town || ''; if (!b.town) b.town = to.town || '';
  const wantBus = mode !== 'car', wantCar = mode !== 'bus';
  const [bus, car] = await Promise.all([
    wantBus ? busTrips(a, b, { fetchImpl, now }).catch(e => { log.warn?.('[TRAVEL] bus timetable unavailable', String(e?.message || e).slice(0, 80)); return { error: 'down' }; }) : null,
    wantCar ? carRoute(a, b, { fetchImpl }).catch(e => { log.warn?.('[TRAVEL] car route unavailable', String(e?.message || e).slice(0, 80)); return null; }) : null
  ]);
  const where = l => l.label + (l.town && !String(l.label).includes(l.town) ? ' ב' + l.town : '');
  const lines = ['מ' + where(a) + ' אל ' + where(b) + ', מרחק בקו אווירי ' + spokenDistance(distanceKm(a, b)) + '.'];
  if (wantBus) {
    if (bus?.trips?.length) {
      lines.push('אוטובוסים ישירים (בלי החלפה) לפי לוח הזמנים הרשמי של משרד התחבורה, שיוצאים בשעה וחצי הקרובה:');
      bus.trips.forEach((t, i) => lines.push((i + 1) + '. ' + (t.rail ? 'רכבת ' : 'קו ') + t.line + (t.agency ? ' של ' + t.agency : '') + ': עולים בתחנה ' + t.board + (t.boardWalkKm != null ? ' (' + spokenDistance(t.boardWalkKm) + ' הליכה)' : '') + ' ב' + spokenTime(t.leaves) + ', יורדים בתחנה ' + t.alight + ' ב' + spokenTime(t.arrives) + ' (' + spokenMin(Math.max(1, Math.round((t.arrivesAt - t.leavesAt) / 60000))) + ' נסיעה)' + (t.alightWalkKm != null ? ', ומשם ' + spokenDistance(t.alightWalkKm) + ' הליכה' : '') + '.'));
    } else if (bus?.error === 'down') lines.push('לוח הזמנים של האוטובוסים לא היה זמין עכשיו.');
    else if (bus?.error === 'no_stops_from') lines.push('לא מצאתי בלוח הזמנים תחנות אוטובוס ליד נקודת המוצא.');
    else if (bus?.error === 'no_stops_to') lines.push('לא מצאתי בלוח הזמנים תחנות אוטובוס ליד היעד.');
    else if (bus) lines.push('לא מצאתי קו ישיר (בלי החלפה) שיוצא בשעה וחצי הקרובה מתחנה ליד נקודת המוצא ומגיע ליד היעד. ייתכן שצריך החלפה' + (bus.fromStops?.length ? '; התחנות הקרובות אליו: ' + bus.fromStops.slice(0, 2).map(s => s.name).join(', ') : '') + '.');
  }
  if (wantCar) {
    if (car?.best) {
      lines.push('ברכב (מסלול רגיל לפי המפה, בלי נתוני עומסים חיים): ' + spokenDistance(car.best.km) + ', בערך ' + spokenMin(car.best.minutes) + ' בלי פקקים. הדרכים לפי הסדר: ' + car.best.roads.map(r => r.label).join(', ') + '.');
      if (car.other && Math.abs(car.other.minutes - car.best.minutes) <= 15) lines.push('דרך חלופית: ' + car.other.roads.map(r => r.label).join(', ') + ', ' + spokenDistance(car.other.km) + ', בערך ' + spokenMin(car.other.minutes) + '.');
    } else lines.push('מסלול הנסיעה ברכב לא היה זמין עכשיו.');
  }
  const roads = car?.best ? [...new Set(car.best.roads.map(r => (r.label.match(/^כביש (\d+)/) || [])[1]).filter(Boolean))] : [];
  return { from: a, to: b, bus, car, roads, text: lines.join('\n') };
}
