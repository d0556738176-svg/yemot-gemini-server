// Owner's log extract (25.11): the server's own log lines for the last hours,
// optionally only those matching a pattern, written under a long random name
// that /owner-report/<name> serves for 2 hours. Read-only: changes nothing,
// restarts nothing. Anything that looks like a key or password is masked.
//   node log-extract.mjs '{"name":"<24 hex>","hours":24,"units":["main","ext2"],"grep":"EXT3|media"}'
import { writeFileSync, mkdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
let req = {};
try { req = JSON.parse(process.argv[2] || '{}'); } catch {}
const name = String(req.name || '');
if (!/^[a-f0-9]{24}$/.test(name)) process.exit(0);
const hours = Math.max(1, Math.min(96, Number(req.hours) || 24));
const units = (Array.isArray(req.units) ? req.units : ['main']).filter(u => ['main', 'ext2'].includes(u));
let re = null;
try { if (req.grep) re = new RegExp(String(req.grep).slice(0, 300), 'i'); } catch {}
const mask = s => String(s)
  .replace(/(key|token|secret|password|passwd|authorization|bearer)([=:"'\s]+)[^\s"',&]+/gi, '$1$2***')
  .replace(/[A-Za-z0-9_\-]{32,}/g, m => /^[a-f0-9]{24}$/.test(m) ? m : m.slice(0, 4) + '…');
const out = ['log extract, last ' + hours + ' h, units ' + units.join(',') + (re ? ', pattern ' + re.source : ''), ''];
for (const u of units) {
  const j = spawnSync('journalctl', ['-u', 'yemot-' + u, '--since', hours + ' hours ago', '-o', 'short-iso', '--no-pager', '-q'], { encoding: 'utf8', maxBuffer: 512 * 1024 * 1024 });
  const lines = String(j.stdout || '').split('\n').filter(l => l && (!re || re.test(l)));
  out.push('==== yemot-' + u + ': ' + lines.length + ' lines ====');
  for (const l of lines.slice(-Number(req.max || 1500))) out.push(mask(l).slice(0, 900));
  out.push('');
}
mkdirSync('/var/lib/yemot-report', { recursive: true, mode: 0o700 });
writeFileSync('/var/lib/yemot-report/' + name + '.txt', out.join('\n'), { mode: 0o600 });
