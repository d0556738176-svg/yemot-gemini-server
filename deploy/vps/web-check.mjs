// Web search engines of extensions 1/3: does each answer, and how fresh is it.
//   node deploy/vps/web-check.mjs
import { readFileSync } from 'node:fs';
const env = Object.fromEntries(readFileSync('/opt/yemot/main.env', 'utf8').split('\n').map(l => l.match(/^([A-Z0-9_]+)="(.*)"$/)).filter(Boolean).map(m => [m[1], m[2]]));
const keys = name => Object.keys(env).filter(k => k === name || k.startsWith(name + '_')).map(k => env[k]).filter(Boolean);
const t = ms => AbortSignal.timeout(ms);
const line = (ok, name, info) => console.log(ok ? 'PASS' : 'FAIL', name, info);
for (const [i, key] of keys('SERPER_API_KEY').entries()) {
  try {
    const r = await fetch('https://google.serper.dev/news', { method: 'POST', signal: t(8000), headers: { 'x-api-key': key, 'content-type': 'application/json' }, body: JSON.stringify({ q: 'חדשות ישראל', gl: 'il', hl: 'iw', num: 5, tbs: 'qdr:d' }) });
    const j = await r.json(); const n = j.news || [];
    line(r.ok && n.length, 'serper news key ' + (i + 1), r.status + ' ' + n.length + ' items, newest: ' + (n[0]?.date || '-') + ' | ' + String(n[0]?.title || j.message || '').slice(0, 60));
  } catch (e) { line(false, 'serper key ' + (i + 1), e.message); }
}
for (const [i, key] of keys('LANGSEARCH_API_KEY').entries()) {
  try {
    const r = await fetch('https://api.langsearch.com/v1/web-search', { method: 'POST', signal: t(8000), headers: { authorization: 'Bearer ' + key, 'content-type': 'application/json' }, body: JSON.stringify({ query: 'מזג האוויר בירושלים היום', freshness: 'oneDay', count: 3 }) });
    const j = await r.json(); const n = j?.data?.webPages?.value || [];
    line(r.ok && n.length, 'langsearch key ' + (i + 1), r.status + ' ' + n.length + ' results | ' + String(n[0]?.name || j.msg || '').slice(0, 60));
  } catch (e) { line(false, 'langsearch key ' + (i + 1), e.message); }
}
for (const [i, key] of keys('EXA_API_KEY').entries()) {
  try {
    const r = await fetch('https://api.exa.ai/search', { method: 'POST', signal: t(8000), headers: { 'x-api-key': key, 'content-type': 'application/json' }, body: JSON.stringify({ query: 'Israel news today', numResults: 3, startPublishedDate: new Date(Date.now() - 2 * 86400000).toISOString() }) });
    const j = await r.json(); const n = j.results || [];
    line(r.ok && n.length, 'exa key ' + (i + 1), r.status + ' ' + n.length + ' results, newest: ' + String(n[0]?.publishedDate || '-').slice(0, 16) + ' | ' + String(n[0]?.title || j.error || '').slice(0, 50));
  } catch (e) { line(false, 'exa key ' + (i + 1), e.message); }
}
try {
  const r = await fetch('https://html.duckduckgo.com/html/?q=' + encodeURIComponent('ynet'), { signal: t(8000), headers: { 'user-agent': 'Mozilla/5.0' } });
  line(r.ok, 'direct web (no key)', 'HTTP ' + r.status);
} catch (e) { line(false, 'direct web (no key)', e.message); }
