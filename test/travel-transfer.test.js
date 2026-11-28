import test from 'node:test';
import assert from 'node:assert/strict';
import { busTrips, trafficRoute, clearTravelCache } from '../travel-tools.js';

const now = new Date('2026-11-29T08:00:00Z'); // Sunday 10:00 Israel
const iso = min => new Date(now.getTime() + min * 60000).toISOString();
const A = { lat: 31.70, lon: 34.99, town: 'בית שמש' }, B = { lat: 32.08, lon: 34.83, town: 'בני ברק' };
const stops = { 'בית שמש': [{ id: 1, code: 1, name: 'מוצא', lat: 31.7001, lon: 34.9901, city: 'בית שמש' }], 'בני ברק': [{ id: 9, code: 9, name: 'יעד', lat: 32.0801, lon: 34.8301, city: 'בני ברק' }] };
const row = (ride, stop, seq, t, line, lat, lon, name) => ({ gtfs_ride_id: ride, gtfs_stop_id: stop, stop_sequence: seq, arrival_time: iso(t), departure_time: iso(t), gtfs_route__route_short_name: line, gtfs_route__agency_name: 'אגד', gtfs_stop__lat: lat, gtfs_stop__lon: lon, gtfs_stop__name: name });
// Ride 100 (line 417): origin -> Jerusalem central (stop 5). Ride 200 (line 402): Jerusalem central (stop 6, 50 m away) -> destination.
const ride100 = [row(100, 1, 1, 5, '417', 31.7001, 34.9901, 'מוצא'), row(100, 5, 9, 45, '417', 31.7890, 35.2030, 'תחנה מרכזית')];
const ride200 = [row(200, 6, 1, 55, '402', 31.7893, 35.2033, 'תחנה מרכזית רציף'), row(200, 9, 12, 120, '402', 32.0801, 34.8301, 'יעד')];
const fetchImpl = async url => {
  const u = new URL(url);
  let body = [];
  if (u.pathname.endsWith('/gtfs_stops/list')) body = stops[u.searchParams.get('city')] || [];
  else if (u.searchParams.get('gtfs_stop_ids') === '1') body = [ride100[0]];
  else if (u.searchParams.get('gtfs_stop_ids') === '9') body = [ride200[1]];
  else if (u.searchParams.get('gtfs_ride_ids') === '100') body = ride100;
  else if (u.searchParams.get('gtfs_ride_ids') === '200') body = ride200;
  return { ok: true, json: async () => body };
};

test('no direct line: one change of bus is found, with the walk and the wait', async () => {
  clearTravelCache();
  const r = await busTrips(A, B, { fetchImpl, now });
  assert.equal(r.trips.length, 0);
  assert.equal(r.transfers.length, 1);
  const t = r.transfers[0];
  assert.equal(t.line1, '417'); assert.equal(t.line2, '402'); assert.equal(t.change, 'תחנה מרכזית'); assert.equal(t.waitMin, 10);
});

test('live traffic: TomTom when it is the key set, the faster route first', async () => {
  clearTravelCache();
  const f = async url => ({ ok: true, json: async () => ({ routes: [{ summary: { travelTimeInSeconds: 3600, noTrafficTravelTimeInSeconds: 2700, trafficDelayInSeconds: 900, lengthInMeters: 60000 } }, { summary: { travelTimeInSeconds: 3000, noTrafficTravelTimeInSeconds: 2900, trafficDelayInSeconds: 100, lengthInMeters: 64000 } }] }) });
  const r = await trafficRoute(A, B, { fetchImpl: f, env: { TOMTOM_API_KEY: 'x' } });
  assert.equal(r.source, 'tomtom'); assert.equal(r.routes[0].minutes, 50); assert.equal(r.routes[1].delayMin, 15);
  assert.equal(await trafficRoute(A, B, { fetchImpl: f, env: {} }), null);
});

test('to a whole town: any stop in that town counts', async () => {
  clearTravelCache();
  const C = { lat: 31.789, lon: 35.203, town: 'ירושלים' }, T = { lat: 31.75, lon: 34.99, town: 'בית שמש', wholeTown: true };
  const st = { 'ירושלים': [{ id: 5, code: 5, name: 'מרכזית', lat: 31.789, lon: 35.203, city: 'ירושלים' }], 'בית שמש': [{ id: 7, code: 7, name: 'יגאל אלון', lat: 31.73, lon: 34.98, city: 'בית שמש' }] };
  const r1 = [row(300, 5, 1, 5, '417', 31.789, 35.203, 'מרכזית'), row(300, 7, 8, 45, '417', 31.73, 34.98, 'יגאל אלון')];
  const f = async url => { const u = new URL(url); let b = []; if (u.pathname.endsWith('/gtfs_stops/list')) b = st[u.searchParams.get('city')] || []; else if (u.searchParams.get('gtfs_stop_ids') === '5') b = [r1[0]]; else if (u.searchParams.get('gtfs_ride_ids') === '300') b = r1; return { ok: true, json: async () => b }; };
  const r = await busTrips(C, T, { fetchImpl: f, now });
  assert.equal(r.trips.length, 1); assert.equal(r.trips[0].line, '417'); assert.equal(r.trips[0].alightWalkKm, null);
});
