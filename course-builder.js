// Course builder service (extension 6). Builds lesson audio (speech + music) on request and
// keeps it until the main service fetches it. It holds no secrets and only builds lessons that
// exist in the course files. GET /lesson?course=english&n=9 -> 200 mp3 when ready, else 202.
import express from 'express';
import { COURSES, loadCourse, hashOf, buildAudio, withTemp, wavToMp3 } from './courses.js';

const courses = Object.fromEntries(COURSES.map(c => [c.id, { c, lessons: new Map(loadCourse(c).lessons.map(l => [l.n, l])) }]));
const store = new Map(); // key -> { state, buf, hash, error, at }
const queue = [];
let busy = false;
const key = (id, n) => id + ':' + n;

function enqueue(id, n) {
  const course = courses[id];
  if (!course?.lessons.has(n)) return;
  const k = key(id, n);
  if (store.has(k) || queue.includes(k)) return;
  queue.push(k);
  store.set(k, { state: 'queued', at: Date.now() });
  pump();
}

async function pump() {
  if (busy) return;
  const k = queue.shift();
  if (!k) return;
  busy = true;
  const [id, ns] = k.split(':');
  const { c, lessons } = courses[id];
  const lesson = lessons.get(Number(ns));
  const t0 = Date.now();
  store.set(k, { state: 'building', at: t0 });
  try {
    const buf = await withTemp('cb-' + id + '-' + ns + '-', async dir => wavToMp3(await buildAudio(lesson.segments, dir, c.music), dir));
    store.set(k, { state: 'ready', buf, hash: hashOf(lesson.segments, c.music), at: Date.now() });
    console.info('[BUILDER] built', k, Math.round((Date.now() - t0) / 1000) + 's', Math.round(buf.length / 1024) + 'KB');
  } catch (e) {
    store.set(k, { state: 'failed', error: String(e?.message || e).slice(0, 300), at: Date.now() });
    console.warn('[BUILDER] failed', k, String(e?.message || e).slice(0, 300));
  } finally {
    busy = false;
    // keep memory small: drop finished lessons older than 2 hours
    for (const [kk, v] of store) if (v.state !== 'building' && v.state !== 'queued' && Date.now() - v.at > 2 * 3600 * 1000) store.delete(kk);
    pump();
  }
}

const app = express();
app.get('/health', (req, res) => res.json({ ok: true, queue: queue.length, busy }));
app.get('/lesson', (req, res) => {
  const id = String(req.query.course || ''), n = Number(req.query.n);
  if (!courses[id] || !courses[id].lessons.has(n)) return res.status(404).json({ error: 'no such lesson' });
  // Build the asked lesson and prepare the next one in the same course, so the next request is ready.
  enqueue(id, n); enqueue(id, n + 1);
  const v = store.get(key(id, n));
  if (v?.state === 'failed') { store.delete(key(id, n)); return res.status(202).json({ state: 'failed', error: v.error }); }
  if (v?.state !== 'ready') return res.status(202).json({ state: v?.state || 'queued', queue: queue.length });
  res.set('x-lesson-hash', v.hash).type('audio/mpeg').send(v.buf);
});
app.listen(process.env.PORT || 10000, () => console.info('[BUILDER] course builder listening'));
