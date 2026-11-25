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
  // A logged object spans several journal lines: they are joined into one
  // block (a line whose message starts with a space or a closing bracket
  // continues the one before), and the pattern is matched on whole blocks.
  const blocks = [];
  for (const l of String(j.stdout || '').split('\n')) {
    if (!l) continue;
    const msg = l.replace(/^\S+\s+\S+\s+\S+?:\s?/, '');
    if (blocks.length && /^(?:\s|[}\]])/.test(msg)) blocks[blocks.length - 1] += ' ' + msg.trim();
    else blocks.push(l);
  }
  const hit = blocks.filter(b => !re || re.test(b));
  out.push('==== yemot-' + u + ': ' + hit.length + ' entries ====');
  for (const l of hit.slice(-Number(req.max || 1500))) out.push(mask(l).slice(0, Number(req.width || 1200)));
  out.push('');
}
mkdirSync('/var/lib/yemot-report', { recursive: true, mode: 0o700 });
writeFileSync('/var/lib/yemot-report/' + name + '.txt', out.join('\n'), { mode: 0o600 });
