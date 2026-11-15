// Yemot account facts that can limit the system (no secrets printed).
//   node deploy/vps/yemot-account.mjs
import { readFileSync } from 'node:fs';
const env = Object.fromEntries(readFileSync('/opt/yemot/main.env', 'utf8').split('\n').map(l => l.match(/^([A-Z0-9_]+)="(.*)"$/)).filter(Boolean).map(m => [m[1], m[2]]));
const token = env.YEMOT_API_USERNAME + ':' + env.YEMOT_API_PASSWORD;
const j = await (await fetch('https://www.call2all.co.il/ym/api/GetSession?' + new URLSearchParams({ token }))).json();
const hide = /token|pass|phone|mail|name|id$|address|ip/i;
for (const [k, v] of Object.entries(j)) if (!hide.test(k)) console.log(k, '=', typeof v === 'object' ? JSON.stringify(v).slice(0, 200) : v);
