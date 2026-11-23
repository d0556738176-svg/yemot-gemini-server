// Owner, 23.11: the server has 2 cores and 4 GB. Background work (many
// downloads in a row, catch-ups, checks) waits while the machine is busy or
// short of memory, so a caller on the line always gets the server first.
// Never throws; after maxWaitMs the work goes ahead anyway.
import os from 'node:os';
import { readFileSync } from 'node:fs';

export function machineRoom() {
  let avail = null;
  try { avail = Math.round(Number(readFileSync('/proc/meminfo', 'utf8').match(/MemAvailable:\s+(\d+)/)?.[1]) / 1024); } catch {}
  const cpus = os.cpus().length || 1;
  return { availMB: avail, load: os.loadavg()[0], cpus };
}
export function busy({ minFreeMB = 700, maxLoadPerCpu = 1.5 } = {}, room = machineRoom()) {
  return (room.availMB != null && room.availMB < minFreeMB) || room.load > room.cpus * maxLoadPerCpu;
}
export async function waitForRoom({ minFreeMB = 700, maxLoadPerCpu = 1.5, maxWaitMs = 20 * 60000, stepMs = 15000, label = '', log = console, roomFn = machineRoom } = {}) {
  const until = Date.now() + maxWaitMs;
  let said = false;
  while (Date.now() < until && busy({ minFreeMB, maxLoadPerCpu }, roomFn())) {
    if (!said) { log.info?.('[ROOM] background work waits for the server to be less busy', { label, ...roomFn() }); said = true; }
    await new Promise(r => setTimeout(r, stepMs));
  }
}
