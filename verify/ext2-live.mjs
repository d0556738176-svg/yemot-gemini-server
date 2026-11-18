// Drives test calls against the LIVE extension 2 server, like Yemot does,
// and prints what the caller would hear. Test number only; downloads are
// always cancelled (3); nothing is downloaded or paid.
const BASE = process.env.EXT2 || 'https://ext2.176-97-205-41.sslip.io';
const WANT = process.env.WANT_COMMIT || '';
const sleep = ms => new Promise(r => setTimeout(r, ms));
let ok = true;
for (let i = 0; i < 90; i++) {
  const d = await fetch(BASE + '/branch2-diag').then(r => r.json()).catch(e => ({ err: String(e) }));
  console.log('running version:', JSON.stringify({ commit: d.commit, startedAt: d.startedAt, err: d.err }));
  if (d.commit && d.commit.startsWith(WANT)) break;
  if (i === 89) { console.log('FAIL: new version not running yet'); process.exit(1); }
  await sleep(20000);
}
async function call(name, steps) {
  console.log('\n===== CALL:', name);
  const id = 'livecheck' + Date.now();
  let params = {};
  for (let i = 0; ; i++) {
    const u = new URL(BASE + '/yemot-youtube');
    for (const [k, v] of Object.entries({ ApiCallId: id, ApiPhone: '0500000099', ApiDID: '0772296638', ApiExtension: '2', ...params })) u.searchParams.set(k, v);
    const t0 = Date.now();
    const text = await fetch(u).then(r => r.text());
    let shown = text; try { shown = decodeURIComponent(text.replace(/\+/g, ' ')); } catch {}
    shown = shown.replace(/\s+/g, ' ');
    console.log('<< (' + (Date.now() - t0) + 'ms) ' + (shown.length > 700 ? shown.slice(0, 380) + ' ….. ' + shown.slice(-300) : shown));
    const m = text.match(/read=.*?=([A-Za-z0-9_]+),/);
    const step = steps[i];
    if (!step) break;
    const [value, expect] = step;
    if (expect && !new RegExp(expect).test(shown)) { ok = false; console.log('!! FAIL expected', expect); }
    else if (expect) console.log('   ok:', expect);
    if (!m || value == null) break;
    console.log('>> ' + m[1] + ' = ' + value);
    params = { [m[1]]: value };
  }
  const u = new URL(BASE + '/yemot-youtube'); for (const [k, v] of Object.entries({ ApiCallId: id, ApiPhone: '0500000099', hangup: 'yes' })) u.searchParams.set(k, v);
  await fetch(u).catch(() => {});
}
await call('channel newest, 20, more, 00 menu, typed choice', [
  ['2', 'להיסטוריית החיפושים הקש 4'],
  ['ערוץ 14 חדש', 'הקלד מה לחפש'],
  ['20', '^read=t-1, .* 20, .*להורדת כל התוצאות הקש 0 0'],
  ['3', 'בחרת את '],
  ['0', '1, '],
  ['00', '21, '],
  ['4', 'הורדת כל 40 התוצאות'],
  ['12347', 'הקש ברצף'],
  ['3', 'בחרת את התוצאות 1, 2, 3, 4 ו 7'],
  ['000', 'ההורדה בוטלה'],
  ['4', 'לחיפוש ביוטיוב בדיבור'],
  ['00', 'ערוץ 14 חדש'],
  ['*', 'לחיפוש ביוטיוב בדיבור'],
]);
await call('English', [['2', ''], ['שיעור על אמונה באנגלית', ''], ['*', '^read=t-1, ']]);
await call('topic', [['2', ''], ['סיפורי ניסים בנושא', ''], ['*', '^read=t-1, ']]);
await call('Yiddish', [['2', ''], ['שירי חתונה ביידיש', ''], ['*', '^read=t-1, ']]);
const d = await fetch(BASE + '/branch2-diag').then(r => r.json());
console.log('\nlast keys the server received:'); for (const k of d.keys.slice(-40)) console.log(JSON.stringify(k));
console.log(ok ? '\nALL CHECKS PASSED' : '\nSOME CHECKS FAILED');
process.exit(ok ? 0 : 1);
