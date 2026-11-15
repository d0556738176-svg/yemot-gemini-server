// Cancels extension 5 right now (pressing 5 -> main menu, channels off).
//   node deploy/vps/ext5-off.mjs
import { readFileSync } from 'node:fs';
for (const l of readFileSync('/opt/yemot/main.env', 'utf8').split('\n')) { const m = l.match(/^([A-Z0-9_]+)="(.*)"$/); if (m && !(m[1] in process.env)) process.env[m[1]] = m[2]; }
const { disableLiveExtension } = await import('../../live-broadcast.js');
await disableLiveExtension();
const r = await fetch('https://www.call2all.co.il/ym/api/GetTextFile?' + new URLSearchParams({ token: process.env.YEMOT_API_USERNAME + ':' + process.env.YEMOT_API_PASSWORD, what: 'ivr2:/5/ext.ini' }));
const j = await r.json();
console.log('ivr2:/5/ext.ini now:', JSON.stringify(j.contents));
