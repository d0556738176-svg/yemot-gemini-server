// Read-only: can this server reach the map services? (status and time only)
const q = '[out:json][timeout:15];nwr["amenity"="place_of_worship"]["religion"="jewish"](around:3000,31.68,34.556);out center tags 5;';
const servers = ['https://overpass-api.de/api/interpreter', 'https://overpass.kumi.systems/api/interpreter', 'https://maps.mail.ru/osm/tools/overpass/api/interpreter', 'https://overpass.private.coffee/api/interpreter', 'https://overpass.osm.ch/api/interpreter'];
const UA = 'yemot-ai-phone/1.0 (owner phone line; contact via github d0556738176-svg)';
async function t(label, p) { const t0 = Date.now(); try { const r = await p; const txt = await r.text(); console.log(label, r.status, (Date.now() - t0) + 'ms', txt.slice(0, 90).replace(/\s+/g, ' ')); } catch (e) { console.log(label, 'ERR', (Date.now() - t0) + 'ms', String(e?.cause?.code || e?.message || e).slice(0, 80)); } }
for (const s of servers) {
  await t('POST ' + s.split('/')[2], fetch(s, { method: 'POST', body: 'data=' + encodeURIComponent(q), headers: { 'content-type': 'application/x-www-form-urlencoded', 'user-agent': UA }, signal: AbortSignal.timeout(20000) }));
  await t('GET  ' + s.split('/')[2], fetch(s + '?data=' + encodeURIComponent(q), { headers: { 'user-agent': UA }, signal: AbortSignal.timeout(20000) }));
}
await t('nominatim', fetch('https://nominatim.openstreetmap.org/search?q=' + encodeURIComponent('אשקלון') + '&format=jsonv2&countrycodes=il', { headers: { 'user-agent': UA }, signal: AbortSignal.timeout(15000) }));
await t('hebcal', fetch('https://www.hebcal.com/zmanim?cfg=json&latitude=31.6&longitude=34.7&tzid=Asia/Jerusalem', { signal: AbortSignal.timeout(15000) }));
