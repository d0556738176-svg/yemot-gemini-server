// End-to-end check on the LIVE extension 2 (test number): one key press for
// audio / video, from YouTube and from another website, then what really
// landed in Yemot (/branch2-saved). Downloads are real (short items).
const BASE = 'https://ext2.176-97-205-41.sslip.io', WANT = process.env.WANT || '';
const sleep = ms => new Promise(r => setTimeout(r, ms));
for (let i = 0; i < 100; i++) { const d = await fetch(BASE + '/branch2-diag').then(r => r.json()).catch(() => ({})); console.log('version', d.commit); if (String(d.commit || '').startsWith(WANT)) break; if (i === 99) process.exit(1); await sleep(20000); }
const t00 = Date.now(), T = () => '[' + Math.round((Date.now() - t00) / 1000) + 's]';
const dur = s => { if (!s) return 1e9; let t = 0; const h = s.match(/(\d+)? ?(שעה|שעתיים|שעות)/); if (h) t += h[2] === 'שעה' ? 3600 : h[2] === 'שעתיים' ? 7200 : +h[1] * 3600; const m = s.match(/(\d+)? ?(דקה|דקות)/); if (m) t += m[2] === 'דקה' ? 60 : +m[1] * 60; const x = s.match(/(\d+) שניות/); if (x) t += +x[1]; return t || 1e9; };
async function call(name, { mode, query, key, minSec = 90, maxSec = 420 }) {
  console.log('\n===== ' + name);
  const id = 'e2e' + Date.now(); let params = {}, picked = false, keyed = false, result = null, tries = 0, yt = 0;
  for (let i = 0; i < 500; i++) {
    const u = new URL(BASE + '/yemot-youtube');
    for (const [k, v] of Object.entries({ ApiCallId: id, ApiPhone: '0500000099', ApiDID: '0772296638', ApiExtension: '2', ...params })) u.searchParams.set(k, v);
    let text = '';
    for (let k = 0; k < 4 && !text.trim(); k++) { if (k) await sleep(15000); text = await fetch(u, { signal: AbortSignal.timeout(120000) }).then(r => r.text()).catch(e => ''); }
    let s = text; try { s = decodeURIComponent(text.replace(/\+/g, ' ')); } catch {} s = s.replace(/\s+/g, ' ');
    const m = text.match(/read=.*?=([A-Za-z0-9_]+),/); const name = m?.[1];
    const show = !/נבדקו|ההורדה נמשכת|הכנת הסרטון נמשכת|ממתין/.test(s) || i < 3;
    if (show) console.log(T(), '<<', s.slice(0, 600));
    if (/id_list_message=/.test(text) || !name) { const h = text.match(/youtubeaudio\/([0-9a-f]{22})\//); result = { played: /משמיע עכשיו/.test(s), id: h ? Buffer.from(h[1], 'hex').toString() : null, text: s.slice(0, 200) }; break; }
    let v = 'None';
    if (i === 0) v = mode;
    else if (/הקלד מה לחפש/.test(s)) v = query;
    else if (/בחרת את /.test(s) && /אורך ([^,.]+)/.test(s) && !keyed && (dur(s.match(/אורך ([^,.]+)/)[1]) > maxSec || dur(s.match(/אורך ([^,.]+)/)[1]) < minSec) && tries < 8) { tries++; v = '3'; picked = false; console.log('   too long/short; back'); }
    else if (!picked && /לבחירה הקש את מספר התוצאה/.test(s) && !/אורך/.test(s)) { yt++; v = String(yt); picked = true; console.log('   PICK youtube #' + yt); }
    else if (!picked && /(^|=t-)(1, |נמצאו)/.test(s) && /אורך|דקות/.test(s)) {
      const items = [...s.matchAll(/(?:^|[ =-])(\d+), (.+?), (?:מאתר [^,]+, )?(?:ערוץ [^,]+, )?(?:אורך )?((?:\d+ )?(?:שעה|שעתיים|שעות|דקה|דקות)[^,.]*)/g)].map(x => ({ n: x[1], t: x[2].slice(0, 50), s: dur(x[3]) }));
      const ok = items.filter(x => x.s >= minSec && x.s <= maxSec);
      const pick = ok[tries % Math.max(1, ok.length)] || items[0];
      console.log('   PICK', JSON.stringify(pick)); v = pick?.n || '1'; picked = true;
    }
    else if (!keyed && /הקש 1/.test(s) && /(להשמעה|כשמע)/.test(s) && /הקש 2/.test(s)) { v = key; keyed = true; }
    else if (/כתובית/.test(s) && /הקש 2/.test(s)) v = '2';
    else if (/בחר שפה|באיזו שפה/.test(s)) v = '1';
    else if (keyed && /התחילה|תישמר|ממשיכה ברקע|אין צורך להמתין|יישמר בתיקיית וידאו/.test(s)) { result = { started: true, text: s.slice(0, 200) }; break; }
    else if (/לבחירה הקש את מספר|האתר לא נתן|לא הצליח/.test(s) && keyed) { result = { failed: s.slice(0, 200) }; break; }
    params = { [name]: v };
    if (v === 'None') await sleep(2500);
  }
  const u = new URL(BASE + '/yemot-youtube'); for (const [k, v] of Object.entries({ ApiCallId: id, ApiPhone: '0500000099', hangup: 'yes' })) u.searchParams.set(k, v); await fetch(u).catch(() => {});
  console.log('   RESULT', JSON.stringify(result));
  return result;
}
const report = async id => fetch(BASE + '/branch2-saved?id=' + id, { signal: AbortSignal.timeout(300000) }).then(r => r.json()).catch(e => ({ err: String(e) }));
const runs = [];
const SC = (process.env.Q || 'a1,w1,v1,w2').split(',');
for (let i = 0; i < 60; i++) { const st = await fetch('https://main.176-97-205-41.sslip.io/web-search-status').then(r => r.json()).catch(() => null); if (st) { console.log('main has the search backups'); break; } await sleep(20000); }
const a1 = !SC.includes('a1') ? null : await call('YouTube key 1 (audio), long', { mode: '2', query: 'שיעור תורה הרב יגאל כהן', key: '1', minSec: 1200, maxSec: 3000 }); runs.push(['YouTube audio', a1?.id]);
const w1 = !SC.includes('w1') ? null : await call('TikTok key 1 (audio)', { mode: '6', query: 'ניגון חסידי טיקטוק', key: '1', minSec: 30, maxSec: 600 }); runs.push(['Website audio', w1?.id]);
const w1b = !SC.includes('w1b') ? null : await call('Website key 1 again (should play at once)', { mode: '6', query: 'שיעור הרב זמיר כהן הידברות', key: '1', minSec: 1200, maxSec: 3600 });
const r0 = await fetch(BASE + '/branch2-saved?recent=1').then(r => r.json()).catch(() => ({}));
const v1 = !SC.includes('v1') ? null : await call('YouTube key 2 (video)', { mode: '2', query: 'סרטון קצר על הכותל', key: '2', minSec: 60, maxSec: 360 });
const w2 = !SC.includes('w2') ? null : await call('Website key 2 (video)', { mode: '6', query: 'ארץ נהדרת קטע מאקו', key: '2', minSec: 60, maxSec: 900 });
const r1 = await fetch(BASE + '/branch2-saved?recent=1').then(r => r.json()).catch(() => ({}));
console.log('recent jobs', JSON.stringify(r1, null, 1));
console.log('search engines', JSON.stringify(await fetch('https://main.176-97-205-41.sslip.io/web-search-status').then(r => r.json()).catch(e => String(e))));
const before = new Set((r0.video || []).map(x => x.id));
for (const j of (r1.video || []).filter(x => !before.has(x.id))) runs.push(['Video ' + j.id, j.id]);
for (let i = 0; i < 1; i++) {}
console.log('\nwaiting 5 minutes for the background copies (extension 7, אודיו, וידאו)...'); await sleep(300000);
for (let round = 0; round < 3; round++) {
  let pending = false;
  for (const [label, id] of runs) {
    if (!id) { console.log('\n#### ' + label + ': no id'); continue; }
    const r = await report(id);
    console.log('\n#### ' + label + ' ' + id + '\n' + JSON.stringify(r, null, 1).slice(0, 3500));
    if (/^Video/.test(label) && r.video?.state !== 'done') pending = true;
    if (!/^Video/.test(label) && (!r.ext7 || !r.audioCopy?.length)) pending = true;
  }
  if (!pending) break;
  console.log('\nsomething not finished yet; waiting 4 more minutes'); await sleep(240000);
}

const dz = await fetch(BASE + '/branch2-diag').then(r => r.json()).catch(() => ({}));
console.log('\nDOWNLOAD EVENTS', JSON.stringify(dz.downloadEvents, null, 1));
console.log('webEvents', JSON.stringify((dz.webEvents || []).slice(-8), null, 1));
