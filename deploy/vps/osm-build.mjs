// Builds the local map tiles from osmium's GeoJSON lines (osm-update.sh).
// One small file per ~5 km square: [lat, lon, name, tags], only the tags the
// place tools use, so a question reads a few files and nothing big stays in memory.
import { createReadStream, mkdirSync, writeFileSync, renameSync, rmSync, existsSync } from 'node:fs';
import { createInterface } from 'node:readline';
const [src, dir] = process.argv.slice(2);
const KEEP = ['amenity', 'religion', 'denomination', 'shop', 'leisure', 'tourism', 'natural', 'highway', 'railway', 'place',
  'addr:street', 'addr:housenumber', 'addr:city', 'phone', 'contact:phone', 'opening_hours', 'name:he'];
const tiles = new Map();
const centre = g => {
  let pts = [];
  const walk = c => { if (typeof c[0] === 'number') pts.push(c); else c.forEach(walk); };
  walk(g.coordinates);
  if (!pts.length) return null;
  if (pts.length > 400) pts = pts.filter((_, i) => i % Math.ceil(pts.length / 400) === 0);
  const lon = pts.reduce((s, p) => s + p[0], 0) / pts.length, lat = pts.reduce((s, p) => s + p[1], 0) / pts.length;
  return [lat, lon];
};
let n = 0;
const rl = createInterface({ input: createReadStream(src), crlfDelay: Infinity });
for await (const line of rl) {
  if (!line.trim()) continue;
  let f; try { f = JSON.parse(line.replace(/^\x1e/, '')); } catch { continue; }
  const p = f.properties || {}, c = f.geometry && centre(f.geometry);
  if (!c) continue;
  const name = p['name:he'] || p.name || '';
  const tags = {}; for (const k of KEEP) if (p[k]) tags[k] = String(p[k]).slice(0, 80);
  // Named roads are kept (for "near X street"), unnamed ones are not.
  if (!name && !Object.keys(tags).some(k => ['amenity', 'shop', 'leisure', 'tourism', 'natural', 'railway'].includes(k) || (k === 'highway' && tags.highway === 'bus_stop'))) continue;
  const key = Math.floor(c[0] * 20) + '_' + Math.floor(c[1] * 20);
  if (!tiles.has(key)) tiles.set(key, []);
  tiles.get(key).push(JSON.stringify([+c[0].toFixed(6), +c[1].toFixed(6), name, tags]));
  n++;
}
const tmp = dir + '/tiles.new';
rmSync(tmp, { recursive: true, force: true }); mkdirSync(tmp, { recursive: true });
for (const [k, rows] of tiles) writeFileSync(tmp + '/' + k + '.jsonl', rows.join('\n'));
if (existsSync(dir + '/tiles')) rmSync(dir + '/tiles.old', { recursive: true, force: true }), renameSync(dir + '/tiles', dir + '/tiles.old');
renameSync(tmp, dir + '/tiles');
rmSync(dir + '/tiles.old', { recursive: true, force: true });
writeFileSync(dir + '/built.json', JSON.stringify({ at: new Date().toISOString(), places: n, tiles: tiles.size }));
console.log('local map: ' + n + ' places in ' + tiles.size + ' tiles');
