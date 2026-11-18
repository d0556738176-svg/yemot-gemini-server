// Read-only-ish live check of extension 2 keys 6 (typed web search) -> pick -> 1 (audio).
// Drives the LIVE ext2 server the way Yemot does and prints every prompt the caller hears.
const BASE = process.env.EXT2 || 'https://ext2.176-97-205-41.sslip.io';
const Q = (await import('node:fs')).readFileSync(new URL('./go.txt', import.meta.url), 'utf8').trim();
const sleep = ms => new Promise(r => setTimeout(r, ms));
const d0 = await fetch(BASE + '/branch2-diag').then(r => r.json()).catch(e => ({ err: String(e) }));
console.log('running version:', d0.commit, d0.startedAt, d0.err || '');
const id = 'webcheck' + Date.now();
let params = {}; const t00 = Date.now();
async function step() {
  const u = new URL(BASE + '/yemot-youtube');
  for (const [k, v] of Object.entries({ ApiCallId: id, ApiPhone: '0500000099', ApiDID: '0772296638', ApiExtension: '2', ...params })) u.searchParams.set(k, v);
  const t0 = Date.now();
  const text = await fetch(u, { signal: AbortSignal.timeout(120000) }).then(r => r.text()).catch(e => 'ERR ' + e);
  let shown = text; try { shown = decodeURIComponent(text.replace(/\+/g, ' ')); } catch {}
  shown = shown.replace(/\s+/g, ' ');
  const m = text.match(/read=.*?=([A-Za-z0-9_]+),/);
  console.log('[' + Math.round((Date.now() - t00) / 1000) + 's] << (' + (Date.now() - t0) + 'ms) ' + (shown.length > 2500 ? shown.slice(0, 2500) + ' …' : shown));
  return { shown, name: m ? m[1] : null };
}
function send(name, v) { console.log('>> ' + name + ' = ' + v); params = { [name]: v }; }
let r = await step();
send(r.name, '6');
r = await step();
send(r.name, Q);
// search progress
for (let i = 0; i < 60; i++) {
  r = await step();
  if (/לבחירה הקש את מספר התוצאה|לא מצאתי|אין תוצאות|חסם/.test(r.shown) || !r.name) break;
  send(r.name, 'None');
}
// choose the shortest non-live result
const items = [...r.shown.matchAll(/(\d+), ([^,]+), מאתר [^,.]+(?:, אורך ([^,.]+))?/g)];
const sec = s => { if (!s) return 99999; let t = 0; const h = s.match(/(\d+)? ?(שעה|שעתיים|שעות)/); if (h) t += h[2] === 'שעה' ? 3600 : h[2] === 'שעתיים' ? 7200 : Number(h[1]) * 3600; const m = s.match(/(\d+)? ?(דקה|דקות)/); if (m) t += m[2] === 'דקה' ? 60 : Number(m[1]) * 60; const ss = s.match(/(\d+) שניות/); if (ss) t += Number(ss[1]); return t || 99999; };
let pick = null;
for (const it of items) { const s = sec(it[3]); if (s >= 60 && (!pick || s < pick.s)) pick = { n: it[1], s, title: it[2] }; }
console.log('PICK', JSON.stringify(pick));
if (!pick || !r.name) { console.log('no result to pick'); process.exit(1); }
send(r.name, pick.n);
r = await step();
send(r.name, '1');
let lastText = '';
for (let i = 0; i < 400; i++) {
  r = await step();
  if (!r.name) break;
  if (/משמיע עכשיו|לא נתן|לא הצליח|אפשר לבחור תוצאה אחרת|לבחירה הקש/.test(r.shown)) { console.log('END STATE'); break; }
  send(r.name, 'None');
  await sleep(1000);
}
const u = new URL(BASE + '/yemot-youtube'); for (const [k, v] of Object.entries({ ApiCallId: id, ApiPhone: '0500000099', hangup: 'yes' })) u.searchParams.set(k, v);
await fetch(u).catch(() => {});
console.log('total seconds', Math.round((Date.now() - t00) / 1000));
