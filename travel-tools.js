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
export async function busTrips(from, to, { fetchImpl = fetch, now = new Date(), windowMin = 90, transfersOn = true } = {}) {
  const [fs, ts] = await Promise.all([townStops(from.town || from.label, { fetchImpl, now }), sameCity(from, to) ? null : townStops(to.town || to.label, { fetchImpl, now })]);
  // 28.11: a whole town as an end ("to Beit Shemesh"): any stop in that town
  // counts (live check: from Jerusalem central station to Beit Shemesh found
  // nothing, because no line stops within 600 m of the town's middle).
  const fromStops = from.wholeTown ? nearest(fs, from, 2.5, 25) : nearest(fs, from, 0.6, 10);
  const toStops = to.wholeTown ? (ts || fs).map(s => ({ ...s, km: distanceKm(to, s) })) : nearest(ts || fs, to, 0.6, 12);
  const townIds = to.wholeTown ? new Set(toStops.map(s => s.id)) : null;
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
  // Each of those rides' own stops (the ride filter works alone; with a stop
  // list too it returned nothing, 19.11), kept where they pass near the
  // destination: by the stop's own position, so no stop is missed.
  const t2 = new Date(now.getTime() + (windowMin + 240) * 60000).toISOString();
  const ids = [...board.keys()].slice(0, 80);
  const chunks = []; for (let i = 0; i < ids.length; i += 20) chunks.push(ids.slice(i, i + 20));
  const lists = await Promise.all(chunks.map(c => rideStops({ gtfs_ride_ids: c.join(','), arrival_time_from: t0, arrival_time_to: t2, limit: 3000 }, { fetchImpl }).catch(() => [])));
  const nearTo = r => Number.isFinite(r.gtfs_stop__lat) ? distanceKm(to, { lat: r.gtfs_stop__lat, lon: r.gtfs_stop__lon }) : (toStops.find(s => s.id === r.gtfs_stop_id)?.km ?? 99);
  let arriving = lists.flat().filter(r => board.has(r.gtfs_ride_id)).map(r => ({ ...r, _km: nearTo(r) }));
  const close = arriving.filter(r => r._km <= 0.6);
  if (townIds) {
    // In the town: per ride, the stop nearest its middle.
    const per = new Map();
    for (const r of arriving.filter(r => townIds.has(r.gtfs_stop_id))) { const p = per.get(r.gtfs_ride_id); if (!p || r._km < p._km) per.set(r.gtfs_ride_id, r); }
    arriving = [...per.values()];
  } else arriving = close.length ? close : arriving.filter(r => r._km <= 1.0);
  const fromKm = new Map(fromStops.map(s => [s.id, s.km])), toKm = new Map(toStops.map(s => [s.id, s.km]));
  const trips = [];
  for (const a of arriving) {
    const b = board.get(a.gtfs_ride_id);
    if (!b || a.stop_sequence <= b.stop_sequence || a.drop_off_type === 1) continue;
    trips.push({
      line: String(b.gtfs_route__route_short_name || ''), agency: b.gtfs_route__agency_name || '', routeName: String(b.gtfs_route__route_long_name || '').replace(/-\d+$/, ''),
      board: b.gtfs_stop__name, boardWalkKm: fromKm.get(b.gtfs_stop_id) ?? null, leaves: israelHHMM(b.departure_time || b.arrival_time), leavesAt: Date.parse(b.departure_time || b.arrival_time),
      alight: a.gtfs_stop__name, alightWalkKm: townIds ? null : a._km ?? toKm.get(a.gtfs_stop_id) ?? null, arrives: israelHHMM(a.arrival_time), arrivesAt: Date.parse(a.arrival_time),
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
  const result = { trips: out.slice(0, 5), fromStops, toStops, debug: { leaving: leaving.length, rides: board.size, arriving: arriving.length, matched: trips.length } };
  // 28.11 (owner: plan the trip the way Moovit does): when there is no direct
  // line, or the direct ones are few, one change of bus is searched too.
  if (result.trips.length < 2 && transfersOn) {
    result.transfers = await busTransfers({ board, firstStops: lists.flat(), toStops, to, now, windowMin, t0, fetchImpl }).catch(e => { result.debug.transferError = String(e?.message || e).slice(0, 80); return []; });
    result.debug.transfers = result.transfers.length;
  }
  return result;
}

// One change of bus: rides that leave near him (with all their later stops)
// meet rides that reach near the destination, at the same stop or within a
// short walk, with at least 3 minutes to change. Earliest arrival first.
const cell = (lat, lon) => Math.round(lat / 0.0025) + '|' + Math.round(lon / 0.003);
async function busTransfers({ board, firstStops, toStops, to, now, windowMin, t0, fetchImpl }) {
  const t3 = new Date(now.getTime() + (windowMin + 180) * 60000).toISOString();
  const reaching = await rideStops({ gtfs_stop_ids: (to.wholeTown ? toStops.slice().sort((x, y) => x.km - y.km).slice(0, 25) : toStops).map(s => s.id).join(','), arrival_time_from: t0, arrival_time_to: t3, limit: 2000 }, { fetchImpl });
  const last = new Map(); // ride -> where it lets him off near the destination
  for (const r of reaching) {
    if (r.drop_off_type === 1 || board.has(r.gtfs_ride_id)) continue;
    const prev = last.get(r.gtfs_ride_id);
    if (!prev || r.stop_sequence < prev.stop_sequence) last.set(r.gtfs_ride_id, r);
  }
  if (!last.size) return [];
  const ids = [...last.keys()].slice(0, 80);
  const chunks = []; for (let i = 0; i < ids.length; i += 20) chunks.push(ids.slice(i, i + 20));
  const second = (await Promise.all(chunks.map(c => rideStops({ gtfs_ride_ids: c.join(','), arrival_time_from: t0, arrival_time_to: t3, limit: 3000 }, { fetchImpl }).catch(() => [])))).flat();
  // Where each second ride can be boarded (before the stop near the destination).
  const grid = new Map();
  for (const r of second) {
    const end = last.get(r.gtfs_ride_id);
    if (!end || r.stop_sequence >= end.stop_sequence || r.pickup_type === 1 || !Number.isFinite(r.gtfs_stop__lat)) continue;
    const k = cell(r.gtfs_stop__lat, r.gtfs_stop__lon);
    if (!grid.has(k)) grid.set(k, []);
    grid.get(k).push(r);
  }
  const toKm = new Map(toStops.map(s => [s.id, s.km]));
  const best = new Map();
  for (const a of firstStops) {
    const b = board.get(a.gtfs_ride_id);
    if (!b || a.stop_sequence <= b.stop_sequence || a.drop_off_type === 1 || !Number.isFinite(a.gtfs_stop__lat)) continue;
    const arrive1 = Date.parse(a.arrival_time);
    const [ci, cj] = cell(a.gtfs_stop__lat, a.gtfs_stop__lon).split('|').map(Number);
    for (let di = -1; di <= 1; di++) for (let dj = -1; dj <= 1; dj++) for (const r of grid.get((ci + di) + '|' + (cj + dj)) || []) {
      const walkKm = distanceKm({ lat: a.gtfs_stop__lat, lon: a.gtfs_stop__lon }, { lat: r.gtfs_stop__lat, lon: r.gtfs_stop__lon });
      if (walkKm > 0.3) continue;
      const leave2 = Date.parse(r.departure_time || r.arrival_time);
      const gap = (leave2 - arrive1) / 60000;
      if (gap < 3 + walkKm * 12 || gap > 40) continue;
      const end = last.get(r.gtfs_ride_id), arrive = Date.parse(end.arrival_time);
      const line1 = String(b.gtfs_route__route_short_name || ''), line2 = String(r.gtfs_route__route_short_name || end.gtfs_route__route_short_name || '');
      if (!line2 || line1 === line2) continue;
      const key = line1 + '>' + line2 + '|' + israelHHMM(b.departure_time || b.arrival_time);
      const t = {
        line1, agency1: b.gtfs_route__agency_name || '', board: b.gtfs_stop__name, leaves: israelHHMM(b.departure_time || b.arrival_time), leavesAt: Date.parse(b.departure_time || b.arrival_time),
        change: a.gtfs_stop__name, changeTo: r.gtfs_stop__name, changeWalkKm: walkKm, reachChange: israelHHMM(a.arrival_time), waitMin: Math.round(gap),
        line2, agency2: r.gtfs_route__agency_name || end.gtfs_route__agency_name || '', leaves2: israelHHMM(r.departure_time || r.arrival_time),
        alight: end.gtfs_stop__name, alightWalkKm: to.wholeTown ? null : toKm.get(end.gtfs_stop_id) ?? (Number.isFinite(end.gtfs_stop__lat) ? distanceKm(to, { lat: end.gtfs_stop__lat, lon: end.gtfs_stop__lon }) : null), arrives: israelHHMM(end.arrival_time), arrivesAt: arrive
      };
      if (!best.has(key) || arrive < best.get(key).arrivesAt) best.set(key, t);
    }
  }
  const perPair = new Map(), out = [];
  for (const t of [...best.values()].sort((x, y) => x.arrivesAt - y.arrivesAt)) {
    const k = t.line1 + '>' + t.line2;
    if ((perPair.get(k) || 0) >= 1) continue;
    perPair.set(k, 1); out.push(t);
  }
  return out.slice(0, 3);
}
const sameCityName = (p, t) => !!plainCity(t) && plainCity(p) === plainCity(t);
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

// Live traffic (owner, 28.11: "like Waze, with today's jams"). Waze and Moovit
// have no public interface; the legal live-traffic routers are Google Routes
// (GOOGLE_MAPS_API_KEY) and TomTom (TOMTOM_API_KEY, free 2,500 a day). With
// neither key set, the usual time from the open map is said, honestly so.
export async function trafficRoute(from, to, { fetchImpl = fetch, env = process.env, now = new Date() } = {}) {
  const g = String(env.GOOGLE_MAPS_API_KEY || '').trim(), tt = String(env.TOMTOM_API_KEY || '').trim();
  const key5 = x => x.lat.toFixed(4) + ',' + x.lon.toFixed(4);
  if (g) {
    try {
      return await cached('gdrive|' + key5(from) + '|' + key5(to), 4 * 60000, async () => {
        const r = await fetchImpl('https://routes.googleapis.com/directions/v2:computeRoutes', { method: 'POST', signal: AbortSignal.timeout(8000),
          headers: { 'content-type': 'application/json', 'X-Goog-Api-Key': g, 'X-Goog-FieldMask': 'routes.duration,routes.staticDuration,routes.distanceMeters,routes.description' },
          body: JSON.stringify({ origin: { location: { latLng: { latitude: from.lat, longitude: from.lon } } }, destination: { location: { latLng: { latitude: to.lat, longitude: to.lon } } }, travelMode: 'DRIVE', routingPreference: 'TRAFFIC_AWARE_OPTIMAL', computeAlternativeRoutes: true, languageCode: 'he', units: 'METRIC' }) });
        const j = await r.json().catch(() => ({}));
        if (!r.ok || !j.routes?.length) throw Object.assign(new Error('Google routes HTTP ' + r.status + ' ' + String(j?.error?.message || '').slice(0, 80)), { status: r.status });
        const routes = j.routes.map(x => ({ minutes: Math.round(parseFloat(x.duration) / 60), freeMinutes: Math.round(parseFloat(x.staticDuration || x.duration) / 60), km: x.distanceMeters / 1000, via: String(x.description || '') })).sort((a, b) => a.minutes - b.minutes);
        return { source: 'google', routes };
      });
    } catch (e) { if (!tt) return { error: String(e?.message || e).slice(0, 120) }; }
  }
  if (tt) {
    try {
      return await cached('tomtom|' + key5(from) + '|' + key5(to), 4 * 60000, async () => {
        const u = 'https://api.tomtom.com/routing/1/calculateRoute/' + key5(from) + ':' + key5(to) + '/json?traffic=true&maxAlternatives=2&routeRepresentation=summaryOnly&computeTravelTimeFor=all&departAt=now&key=' + encodeURIComponent(tt);
        const r = await fetchImpl(u, { signal: AbortSignal.timeout(8000) });
        const j = await r.json().catch(() => ({}));
        if (!r.ok || !j.routes?.length) throw Object.assign(new Error('TomTom HTTP ' + r.status), { status: r.status });
        const routes = j.routes.map(x => ({ minutes: Math.round(x.summary.travelTimeInSeconds / 60), freeMinutes: Math.round((x.summary.noTrafficTravelTimeInSeconds || x.summary.travelTimeInSeconds) / 60), delayMin: Math.round((x.summary.trafficDelayInSeconds || 0) / 60), km: x.summary.lengthInMeters / 1000 })).sort((a, b) => a.minutes - b.minutes);
        return { source: 'tomtom', routes };
      });
    } catch (e) { return { error: String(e?.message || e).slice(0, 120) }; }
  }
  return null;
}

const spokenMin = m => m < 60 ? m + ' דקות' : Math.floor(m / 60) + ' שעות' + (m % 60 ? ' ו-' + (m % 60) + ' דקות' : '');

/**
 * Everything for the answer: geocodes both ends, then bus and/or car.
 * from/to: { place, town }. mode: 'bus' | 'car' | 'any'.
 */
export async function travelFacts({ from = {}, to = {}, mode = 'any' } = {}, { fetchImpl = fetch, log = console, now = new Date(), env = process.env } = {}) {
  const [a, b] = await Promise.all([geocode(from, { fetchImpl, log }).catch(() => null), geocode(to, { fetchImpl, log }).catch(() => null)]);
  if (!a || !b) return { unknown: !a ? (from.place || from.town || 'נקודת המוצא') : (to.place || to.town || 'היעד'), missing: !a ? 'from' : 'to' };
  if (!a.town) a.town = from.town || ''; if (!b.town) b.town = to.town || '';
  if (!String(from.place || '').trim() || sameCityName(from.place, from.town)) a.wholeTown = true;
  if (!String(to.place || '').trim() || sameCityName(to.place, to.town)) b.wholeTown = true;
  const wantBus = mode !== 'car', wantCar = mode !== 'bus';
  const [bus, car, live] = await Promise.all([
    wantBus ? busTrips(a, b, { fetchImpl, now }).catch(e => { log.warn?.('[TRAVEL] bus timetable unavailable', String(e?.message || e).slice(0, 80)); return { error: 'down' }; }) : null,
    wantCar ? carRoute(a, b, { fetchImpl }).catch(e => { log.warn?.('[TRAVEL] car route unavailable', String(e?.message || e).slice(0, 80)); return null; }) : null,
    wantCar ? trafficRoute(a, b, { fetchImpl, env, now }).catch(() => null) : null
  ]);
  if (live?.error) log.warn?.('[TRAVEL] live traffic unavailable', live.error);
  const where = l => l.label + (l.town && !String(l.label).includes(l.town) ? ' ב' + l.town : '');
  const lines = ['מ' + where(a) + ' אל ' + where(b) + ', מרחק בקו אווירי ' + spokenDistance(distanceKm(a, b)) + '.'];
  if (wantBus) {
    if (bus?.trips?.length) {
      lines.push('אוטובוסים ישירים (בלי החלפה) לפי לוח הזמנים הרשמי של משרד התחבורה, שיוצאים בשעה וחצי הקרובה:');
      bus.trips.forEach((t, i) => lines.push((i + 1) + '. ' + (t.rail ? 'רכבת ' : 'קו ') + t.line + (t.agency ? ' של ' + t.agency : '') + ': עולים בתחנה ' + t.board + (t.boardWalkKm != null ? ' (' + spokenDistance(t.boardWalkKm) + ' הליכה)' : '') + ' ב' + spokenTime(t.leaves) + ', יורדים בתחנה ' + t.alight + ' ב' + spokenTime(t.arrives) + ' (' + spokenMin(Math.max(1, Math.round((t.arrivesAt - t.leavesAt) / 60000))) + ' נסיעה)' + (t.alightWalkKm != null ? ', ומשם ' + spokenDistance(t.alightWalkKm) + ' הליכה' : '') + '.'));
    } else if (bus?.error === 'down') lines.push('לוח הזמנים של האוטובוסים לא היה זמין עכשיו.');
    else if (bus?.error === 'no_stops_from') lines.push('לא מצאתי בלוח הזמנים תחנות אוטובוס ליד נקודת המוצא.');
    else if (bus?.error === 'no_stops_to') lines.push('לא מצאתי בלוח הזמנים תחנות אוטובוס ליד היעד.');
    if (bus?.transfers?.length) {
      lines.push((bus.trips?.length ? 'ועוד ' : '') + 'אפשרויות עם החלפה אחת (לוח הזמנים הרשמי), לפי שעת ההגעה:');
      bus.transfers.forEach((t, i) => lines.push((i + 1) + '. קו ' + t.line1 + (t.agency1 ? ' של ' + t.agency1 : '') + ' מהתחנה ' + t.board + ' ב' + spokenTime(t.leaves) + ', יורדים בתחנה ' + t.change + ' ב' + spokenTime(t.reachChange) +
        (t.changeTo && t.changeTo !== t.change ? ', הולכים ' + spokenDistance(t.changeWalkKm) + ' לתחנה ' + t.changeTo : '') + ', ועולים לקו ' + t.line2 + (t.agency2 && t.agency2 !== t.agency1 ? ' של ' + t.agency2 : '') + ' שיוצא ב' + spokenTime(t.leaves2) + ' (המתנה של ' + spokenMin(Math.max(1, t.waitMin)) + '), יורדים בתחנה ' + t.alight + ' ב' + spokenTime(t.arrives) +
        (t.alightWalkKm != null ? ', ומשם ' + spokenDistance(t.alightWalkKm) + ' הליכה' : '') + '. סך הכל ' + spokenMin(Math.max(1, Math.round((t.arrivesAt - t.leavesAt) / 60000))) + '.'));
    }
    else if (bus && !bus.trips?.length && !bus.error) lines.push('לא מצאתי קו ישיר (בלי החלפה) שיוצא בשעה וחצי הקרובה מתחנה ליד נקודת המוצא ומגיע ליד היעד. ולא מצאתי גם אפשרות עם החלפה אחת בזמן הזה' + (bus.fromStops?.length ? '; התחנות הקרובות אליו: ' + bus.fromStops.slice(0, 2).map(s => s.name).join(', ') : '') + '.');
  }
  if (wantCar) {
    const fast = live?.routes?.[0];
    if (fast) {
      const delay = fast.delayMin ?? Math.max(0, fast.minutes - fast.freeMinutes);
      lines.push('ברכב, לפי מצב התנועה עכשיו (' + (live.source === 'google' ? 'גוגל מפות' : 'טום טום') + ', כולל פקקים): ' + spokenMin(fast.minutes) + ', ' + spokenDistance(fast.km) + (fast.via ? ' דרך ' + fast.via : '') +
        (delay >= 3 ? '; בגלל העומס זה ' + spokenMin(delay) + ' יותר מבלי פקקים' : '; כמעט בלי עיכובי תנועה') + '.');
      const alt = live.routes[1];
      if (alt) lines.push('דרך אחרת עכשיו: ' + spokenMin(alt.minutes) + ', ' + spokenDistance(alt.km) + (alt.via ? ' דרך ' + alt.via : '') + '.');
      if (car?.best) lines.push('הכבישים במסלול הרגיל לפי המפה, לפי הסדר: ' + car.best.roads.map(r => r.label).join(', ') + '.');
    } else if (car?.best) {
      lines.push('ברכב (מסלול רגיל לפי המפה, בלי נתוני עומסים חיים): ' + spokenDistance(car.best.km) + ', בערך ' + spokenMin(car.best.minutes) + ' בלי פקקים. הדרכים לפי הסדר: ' + car.best.roads.map(r => r.label).join(', ') + '.');
      if (car.other && Math.abs(car.other.minutes - car.best.minutes) <= 15) lines.push('דרך חלופית: ' + car.other.roads.map(r => r.label).join(', ') + ', ' + spokenDistance(car.other.km) + ', בערך ' + spokenMin(car.other.minutes) + '.');
    } else lines.push('מסלול הנסיעה ברכב לא היה זמין עכשיו.');
  }
  const roads = car?.best ? [...new Set(car.best.roads.map(r => (r.label.match(/^כביש (\d+)/) || [])[1]).filter(Boolean))] : [];
  return { from: a, to: b, bus, car, live: live?.routes ? live : null, roads, text: lines.join('\n') };
}
