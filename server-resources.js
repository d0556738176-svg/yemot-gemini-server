// Owner, 23.11: the hosting panel says the server reaches its resource limit.
// Read-only picture of the machine: load, memory, swap, disk and the
// heaviest processes (command lines trimmed, anything secret-looking hidden).
import os from 'node:os';
import { readFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';

function run(bin, args) {
  return new Promise(resolve => {
    const p = spawn(bin, args, { stdio: ['ignore', 'pipe', 'ignore'] });
    let out = ''; p.stdout.on('data', d => { out += d; });
    const t = setTimeout(() => p.kill('SIGKILL'), 15000);
    p.on('error', () => { clearTimeout(t); resolve(''); });
    p.on('close', () => { clearTimeout(t); resolve(out); });
  });
}
const hide = s => String(s).replace(/(token|key|secret|password|pass|auth)[=:]\S+/gi, '$1=[x]').replace(/[A-Za-z0-9_-]{32,}/g, '[x]').replace(/https?:\/\/\S+/g, '[url]');
export async function resourcesReport() {
  const mem = Object.fromEntries((await readFile('/proc/meminfo', 'utf8').catch(() => '')).split('\n').map(l => l.match(/^(\w+):\s+(\d+)/)).filter(Boolean).map(m => [m[1], Math.round(Number(m[2]) / 1024)]));
  const ps = (await run('ps', ['-eo', 'pid,ppid,etimes,pcpu,rss,comm,args', '--sort=-rss', '--no-headers'])).trim().split('\n');
  const procs = ps.map(l => { const m = l.trim().match(/^(\d+)\s+(\d+)\s+(\d+)\s+([\d.]+)\s+(\d+)\s+(\S+)\s+(.*)$/); return m && { pid: +m[1], ppid: +m[2], ageMin: Math.round(+m[3] / 60), cpu: +m[4], rssMB: Math.round(+m[5] / 1024), name: m[6], cmd: hide(m[7]).slice(0, 160) }; }).filter(Boolean);
  const groups = {};
  for (const p of procs) { const g = groups[p.name] ||= { count: 0, rssMB: 0, cpu: 0, oldestMin: 0 }; g.count++; g.rssMB += p.rssMB; g.cpu += p.cpu; g.oldestMin = Math.max(g.oldestMin, p.ageMin); }
  const stat = s => (s.match(/cpu\s+(.*)/)?.[1] || '').split(/\s+/).map(Number);
  const a = stat(await readFile('/proc/stat', 'utf8').catch(() => '')); await new Promise(r => setTimeout(r, 2000)); const b = stat(await readFile('/proc/stat', 'utf8').catch(() => ''));
  const tot = b.reduce((x, y) => x + y, 0) - a.reduce((x, y) => x + y, 0), idle = (b[3] + b[4]) - (a[3] + a[4]);
  return {
    at: new Date().toISOString(), cpus: os.cpus().length, load: os.loadavg().map(x => +x.toFixed(2)), cpuBusyPct: tot ? Math.round(100 * (tot - idle) / tot) : null,
    uptimeH: Math.round(os.uptime() / 3600),
    memMB: { total: mem.MemTotal, available: mem.MemAvailable, swapTotal: mem.SwapTotal, swapFree: mem.SwapFree },
    disk: (await run('df', ['-m', '/', '/tmp'])).trim().split('\n').slice(1).map(l => l.split(/\s+/)).map(c => ({ fs: c[5], totalMB: +c[1], usedMB: +c[2], freeMB: +c[3], usePct: c[4] })),
    tmpBig: (await run('du', ['-xsm', '/tmp', '/var/tmp', '/var/log/journal', '/root/.cache'])).trim().split('\n'),
    groups: Object.entries(groups).sort((x, y) => y[1].rssMB - x[1].rssMB).slice(0, 15),
    topMem: procs.slice(0, 12), topCpu: [...procs].sort((x, y) => y.cpu - x.cpu).slice(0, 10),
  };
}
