import fs from 'node:fs/promises';
import path from 'node:path';
import express from 'express';
import { YemotRouter } from 'yemot-router2';
import { Store, sources, scanChannel, Worker } from './core.mjs';
import { readEnv, youtubeAPI, freeDownloader, yemotClient, resourceAvailable } from './adapters.mjs';

const dataDir = process.env.NEWS5_DATA_DIR || '/var/lib/yemot-news5';
await fs.mkdir(dataDir, { recursive: true, mode: 0o700 });
const command = process.argv[2] || 'check';
const branch2Env = await readEnv(process.env.NEWS5_BRANCH2_ENV || '/opt/yemot/ext2.env');
const mainEnv = await readEnv(process.env.NEWS5_MAIN_ENV || '/opt/yemot/main.env');
const keys = Object.entries(branch2Env).filter(([k]) => /^(?:YOUTUBE|YT)_API_KEY(?:_?\d+)?$/.test(k)).map(([, v]) => v);
const api = youtubeAPI(keys);
const store = new Store(path.join(dataDir, 'news.sqlite'));
const yemot = yemotClient(mainEnv);
const stop = new AbortController();
const log = (event, details = {}) => console.info('[NEWS5]', event, details);

if (command === 'check') {
  for (const source of sources) {
    try {
      const result = await api('channels', { part: 'snippet,contentDetails', ...(source.id ? { id: source.id } : { forHandle: source.handle }) });
      const channel = result.items?.[0];
      log('SOURCE_CHECK', { key: source.key, id: channel?.id || null, title: channel?.snippet?.title || null, uploads: !!channel?.contentDetails?.relatedPlaylists?.uploads });
      if (!channel?.contentDetails?.relatedPlaylists?.uploads) process.exitCode = 1;
    } catch { log('SOURCE_CHECK_FAILED', { key: source.key }); process.exitCode = 1; }
  }
  store.close();
} else if (command === 'status') {
  console.log(JSON.stringify({ queue: store.stats(), sources: sources.map(s => ({ key: s.key, ...store.channel(s.key) })) }));
  store.close();
} else if (command === 'activate') {
  if (!/^[a-f0-9]{48,}$/.test(process.env.NEWS5_ACCESS_KEY || '')) throw Error('access_key_required');
  if (!store.latest('', 1).length) throw Error('no_verified_audio_yet');
  // These flags stop the existing main service from resetting extension 5 on
  // its next restart. Do not mutate that service or its environment here.
  if (mainEnv.BRANCH5_ENABLED !== 'true' || mainEnv.BRANCH5_LIVE_AUTO_CONFIGURE !== 'false') throw Error('branch5_startup_flags_required');
  const before = await yemot.getExtension();
  await fs.writeFile(path.join(dataDir, 'ext5-before-' + Date.now() + '.ini'), String(before || ''), { mode: 0o600 });
  const url = new URL(process.env.NEWS5_PUBLIC_URL);
  if (url.protocol !== 'https:') throw Error('https_required');
  url.pathname = '/news/' + process.env.NEWS5_ACCESS_KEY;
  url.search = '';
  await yemot.activate(url.href);
  log('EXTENSION5_ACTIVATED');
  store.close();
} else if (command === 'serve') {
  if (!/^[a-f0-9]{48,}$/.test(process.env.NEWS5_ACCESS_KEY || '')) throw Error('access_key_required');
  // Exclusive process lock. systemd owns this PID and kills children on stop.
  const lockPath = path.join(dataDir, 'worker.lock');
  let lock;
  try { lock = await fs.open(lockPath, 'wx', 0o600); }
  catch {
    const pid = Number(await fs.readFile(lockPath, 'utf8'));
    try { process.kill(pid, 0); throw Error('worker_already_running'); }
    catch (e) { if (e.code !== 'ESRCH') throw e; }
    await fs.unlink(lockPath);
    lock = await fs.open(lockPath, 'wx', 0o600);
  }
  await lock.writeFile(String(process.pid));
  store.recover();
  const workDir = path.join(dataDir, 'tmp');
  await fs.mkdir(workDir, { recursive: true, mode: 0o700 });
  // Previous process has stopped and held no network jobs now.
  for (const name of await fs.readdir(workDir)) if (name.startsWith('item-')) await fs.rm(path.join(workDir, name), { recursive: true, force: true });
  const download = await freeDownloader({ modulePath: process.env.NEWS5_BRANCH2_MODULE || '/opt/yemot/ext2/youtube-direct.js', workDir, api, signal: stop.signal,
    bin: process.env.NEWS5_YTDLP_WRAPPER || '/opt/yemot/news5/branch5-news/limited-ytdlp.sh' });
  const worker = new Worker(store, { download, publish: yemot.publish, admit: () => resourceAvailable(workDir) });
  let scanning = false;
  async function scan() {
    if (scanning || stop.signal.aborted) return;
    scanning = true;
    try {
      for (const source of sources) {
        if (stop.signal.aborted) break;
        try { await scanChannel(store, source, api); }
        catch { store.setChannel(source.key, { error: 'metadata_unavailable', checked: Date.now() }); log('SOURCE_DELAYED', { key: source.key }); }
      }
      log('QUEUE', { states: store.stats() });
    } finally { scanning = false; }
  }
  const app = express();
  app.use(express.urlencoded({ extended: false, limit: '64kb' }));
  const router = YemotRouter({ printLog: false });
  const say = value => String(value).replace(/[^\p{L}\p{N}\s]/gu, ' ').replace(/\s+/g, ' ').slice(0, 500);
  router.get('/news/' + process.env.NEWS5_ACCESS_KEY, async call => {
    let source = '', offset = 0, snapshot = Date.now();
    for (;;) {
      const item = store.latest(source, 1, offset, snapshot)[0];
      const origin = sources.find(s => s.key === item?.source);
      const stamp = item ? new Intl.DateTimeFormat('he-IL', { timeZone: 'Asia/Jerusalem', day: 'numeric', month: 'numeric', hour: '2-digit', minute: '2-digit' }).format(item.published) : '';
      const text = item ? say(origin.title + ' ' + item.title + ' פורסם ' + stamp) : 'אין כרגע פריטים נוספים מוכנים להשמעה';
      const key = String(await call.read([
        { type: 'text', data: text },
        ...(item?.paths || []).map(data => ({ type: 'file', data })),
        { type: 'text', data: 'להשמעה חוזרת הקישו 1 לפריט הבא 2 לקודם 3 לבחירת ערוץ 4 לרענון 5 ולתפריט הראשי 0' },
      ], 'tap', { max_digits: 1, min_digits: 1, sec_wait: 3, allow_empty: true, empty_val: item ? '2' : '4', typing_playback_mode: 'No', timeout: 24 * 3600000 }));
      if (key === '0' || key.includes('*')) return call.go_to_folder('/');
      if (key === '2' && item) offset++;
      if (key === '3') offset = Math.max(0, offset - 1);
      if (key === '5') { snapshot = Date.now(); offset = 0; }
      if (key === '4') {
        const selected = String(await call.read([{ type: 'text', data: 'לכל הערוצים הקישו 9 ' + sources.map((s, i) => 'ל' + s.title + ' הקישו ' + (i + 1)).join(' ') + ' לחזרה לתפריט הראשי הקישו 0' }], 'tap', { max_digits: 1, min_digits: 1, sec_wait: 10, allow_empty: true, empty_val: '9' }));
        if (selected === '0' || selected.includes('*')) return call.go_to_folder('/');
        source = sources[Number(selected) - 1]?.key || '';
        offset = 0; snapshot = Date.now();
      }
    }
  });
  app.get('/health', (_req, res) => res.json({ ok: true, service: 'news5', queue: store.stats() }));
  app.use(router);
  const server = app.listen(Number(process.env.NEWS5_PORT || 3005), '127.0.0.1');
  let scanTimer, jobTimer;
  if (process.env.NEWS5_ENABLED === 'true') {
    void scan();
    scanTimer = setInterval(() => void scan(), 5 * 60000);
    jobTimer = setInterval(() => { if (!stop.signal.aborted) void worker.tick(); }, 5000);
  }
  async function shutdown() {
    if (stop.signal.aborted) return;
    stop.abort(); clearInterval(scanTimer); clearInterval(jobTimer); server.close();
    while (worker.busy || scanning) await new Promise(r => setTimeout(r, 100));
    store.close(); await lock.close(); await fs.unlink(lockPath); process.exit(0);
  }
  process.on('SIGTERM', shutdown); process.on('SIGINT', shutdown);
  log('LISTENING', { downloadsEnabled: process.env.NEWS5_ENABLED === 'true' });
} else { throw Error('unknown_command'); }
