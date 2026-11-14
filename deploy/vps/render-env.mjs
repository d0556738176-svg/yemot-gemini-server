// Copy a Render service's environment variables into an env file for systemd.
// Usage: node render-env.mjs <serviceId> <outFile> [KEY=VALUE overrides...]
// Reads the Render API key from /root/.render-key. Prints names only, never values.
import { readFileSync, writeFileSync } from 'node:fs';
const [id, out, ...over] = process.argv.slice(2);
const key = readFileSync('/root/.render-key', 'utf8').trim();
const vars = {};
let cursor = '';
for (;;) {
  const r = await fetch(`https://api.render.com/v1/services/${id}/env-vars?limit=100${cursor ? '&cursor=' + encodeURIComponent(cursor) : ''}`,
    { headers: { Authorization: 'Bearer ' + key, Accept: 'application/json' } });
  if (!r.ok) { console.error('Render API', r.status, await r.text()); process.exit(1); }
  const page = await r.json();
  for (const it of page) vars[it.envVar.key] = it.envVar.value;
  if (page.length < 100) break;
  cursor = page[page.length - 1].cursor;
}
for (const o of over) { const i = o.indexOf('='); vars[o.slice(0, i)] = o.slice(i + 1); }
const esc = v => '"' + String(v).replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n') + '"';
writeFileSync(out, Object.entries(vars).map(([k, v]) => `${k}=${esc(v)}`).join('\n') + '\n', { mode: 0o600 });
console.log(id, '->', out, Object.keys(vars).length, 'settings:', Object.keys(vars).sort().join(' '));
