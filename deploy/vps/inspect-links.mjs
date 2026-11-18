// READ-ONLY: where every Yemot extension's api_link points (host only).
//   node inspect-links.mjs
import { readFileSync } from 'node:fs';
const env = Object.fromEntries(readFileSync('/opt/yemot/main.env', 'utf8').split('\n').map(l => l.match(/^([A-Z0-9_]+)="(.*)"$/)).filter(Boolean).map(m => [m[1], m[2]]));
const token = env.YEMOT_API_USERNAME + ':' + env.YEMOT_API_PASSWORD;
const get = async (m, p) => (await fetch('https://www.call2all.co.il/ym/api/' + m + '?' + new URLSearchParams({ token, ...p }), { signal: AbortSignal.timeout(20000) })).json().catch(() => ({}));
const paths = ['ivr2:/'];
for (let i = 0; i <= 9; i++) paths.push('ivr2:/' + i);
for (const top of [1, 2, 3, 6, 7]) for (let i = 0; i <= 9; i++) paths.push('ivr2:/' + top + '/' + i);
const hosts = {};
for (const p of paths) {
  const j = await get('GetTextFile', { what: p + '/ext.ini' });
  if (j.responseStatus !== 'OK' || !j.contents) continue;
  const type = (String(j.contents).match(/^type=(.*)$/m) || [])[1] || '?';
  const links = [...String(j.contents).matchAll(/https?:\/\/([^\/\s?]+)(\/[^\s?]*)?/g)].map(m => m[1] + (m[2] || ''));
  console.log(p.padEnd(12), type.padEnd(14), links.join(' ') || '-');
  for (const l of links) { const h = l.split('/')[0]; hosts[h] = (hosts[h] || 0) + 1; }
}
console.log('HOSTS', JSON.stringify(hosts));
