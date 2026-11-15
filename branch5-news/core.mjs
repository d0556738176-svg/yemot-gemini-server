import { DatabaseSync } from 'node:sqlite';

export const sources = [
  { key: 'kan', title: 'כאן חדשות', handle: 'kan11news' },
  { key: 'n12', title: 'חדשות 12', handle: 'israelnews' },
  { key: 'n13', title: 'חדשות 13', id: 'UCvQmPpU20hw1Trss_CVwaew' },
  { key: 'c14', title: 'ערוץ 14', handle: 'c14news' },
  { key: 'i24', title: 'איי 24', id: 'UCisowXt5wZkp2sR3rFh9lnQ' },
  { key: 'ynet', title: 'וויינט', id: 'UCpSSzrovhI4fA2PQNItecUA' },
  { key: 'knesset', title: 'ערוץ הכנסת', handle: 'knessettv' },
  { key: 'kikar', title: 'כיכר השבת', id: 'UCKK1JzwJzAVVJToQ4ezjDtg' },
];

export class Store {
  constructor(file, now = Date.now()) {
    this.db = new DatabaseSync(file);
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS channels (key TEXT PRIMARY KEY, playlist TEXT, cursor TEXT, boundary INTEGER, scan_end INTEGER, checked INTEGER, error TEXT);
      CREATE TABLE IF NOT EXISTS items (id TEXT PRIMARY KEY, source TEXT NOT NULL, title TEXT NOT NULL, published INTEGER NOT NULL,
        status TEXT NOT NULL DEFAULT 'queued', attempts INTEGER NOT NULL DEFAULT 0, due INTEGER NOT NULL DEFAULT 0, paths TEXT, error TEXT, ready_at INTEGER);
      CREATE INDEX IF NOT EXISTS queue ON items(status,due,published);`);
    this.db.prepare('INSERT OR IGNORE INTO settings VALUES (?,?)').run('activated', String(now));
  }
  recover() { this.db.exec("UPDATE items SET status='queued' WHERE status='running'"); }
  activated() { return Number(this.db.prepare("SELECT value FROM settings WHERE key='activated'").get().value); }
  channel(key) { return this.db.prepare('SELECT * FROM channels WHERE key=?').get(key); }
  setChannel(key, values) {
    this.db.prepare('INSERT OR IGNORE INTO channels(key,boundary) VALUES (?,?)').run(key, this.activated());
    for (const [name, value] of Object.entries(values)) {
      if (!['playlist','cursor','boundary','scan_end','checked','error'].includes(name)) throw Error('invalid field');
      this.db.prepare(`UPDATE channels SET ${name}=? WHERE key=?`).run(value ?? null, key);
    }
  }
  add(item) {
    if (!/^[\w-]{11}$/.test(item.id) || !sources.some(s => s.key === item.source) || !Number.isFinite(item.published)) return;
    this.db.prepare('INSERT OR IGNORE INTO items(id,source,title,published) VALUES (?,?,?,?)')
      .run(item.id, item.source, String(item.title).slice(0, 300), item.published);
  }
  next(now = Date.now()) {
    // Oldest queued first prevents starvation; listening order is independently newest first.
    return this.db.prepare("SELECT * FROM items WHERE status='queued' AND due<=? ORDER BY published,id LIMIT 1").get(now);
  }
  begin(id) { this.db.prepare("UPDATE items SET status='running',attempts=attempts+1 WHERE id=?").run(id); }
  ready(id, paths) {
    if (!paths.length || paths.some(p => !/^\/5\/news\/[\w-]+$/.test(p))) throw Error('invalid playback paths');
    this.db.prepare("UPDATE items SET status='ready',paths=?,error=NULL,ready_at=? WHERE id=?").run(JSON.stringify(paths), Date.now(), id);
  }
  failed(id, code, now = Date.now()) {
    const item = this.db.prepare('SELECT attempts FROM items WHERE id=?').get(id);
    const attempts = item.attempts;
    this.db.prepare('UPDATE items SET status=?,error=?,due=? WHERE id=?')
      .run(attempts >= 3 ? 'failed' : 'queued', String(code).slice(0, 60), now + Math.min(3600000, 60000 * 5 ** attempts), id);
  }
  deferLive(id, now = Date.now()) {
    this.db.prepare("UPDATE items SET status='queued',attempts=MAX(0,attempts-1),due=?,error='video_not_ready' WHERE id=?")
      .run(now + 15 * 60000, id);
  }
  latest(source = '', limit = 200, offset = 0, snapshot = Date.now()) {
    return this.db.prepare("SELECT * FROM items WHERE status='ready' AND ready_at<=? AND (?='' OR source=?) ORDER BY published DESC,id DESC LIMIT ? OFFSET ?")
      .all(snapshot, source, source, limit, offset).map(x => ({ ...x, paths: JSON.parse(x.paths) }));
  }
  stats() { return this.db.prepare('SELECT status,COUNT(*) AS count FROM items GROUP BY status').all(); }
  close() { this.db.close(); }
}

// Scan the uploads playlist (including Shorts), not a limited RSS window.
// Cursor and boundary survive restarts and queue pressure. A scan only advances
// its boundary once every page has been visited; failed fetches never advance it.
export async function scanChannel(store, source, api, { pageBudget = 4, now = Date.now() } = {}) {
  let channel = store.channel(source.key);
  if (!channel?.playlist) {
    const result = await api('channels', { part: 'contentDetails,snippet', ...(source.id ? { id: source.id } : { forHandle: source.handle }) });
    const playlist = result.items?.[0]?.contentDetails?.relatedPlaylists?.uploads;
    if (!playlist) throw Error('channel_unresolved');
    store.setChannel(source.key, { playlist });
    channel = store.channel(source.key);
  }
  if (!channel.scan_end) {
    store.setChannel(source.key, { scan_end: now });
    channel = store.channel(source.key);
  }
  let cursor = channel.cursor || '';
  for (let page = 0; page < pageBudget; page++) {
    const result = await api('playlistItems', { part: 'contentDetails,snippet', playlistId: channel.playlist, maxResults: '50', ...(cursor ? { pageToken: cursor } : {}) });
    let reachedBoundary = false;
    for (const entry of result.items || []) {
      const published = Date.parse(entry.contentDetails?.videoPublishedAt || entry.snippet?.publishedAt || '');
      if (!Number.isFinite(published)) continue;
      // Overlap lets a late-visible upload enter on the next scan; activation
      // remains a hard floor so old archives are never downloaded on startup.
      if (published < Math.max(store.activated(), channel.boundary - 86400000)) { reachedBoundary = true; continue; }
      store.add({ id: entry.contentDetails?.videoId, source: source.key, title: entry.snippet?.title || source.title, published });
    }
    cursor = result.nextPageToken || '';
    if (!cursor || reachedBoundary) {
      store.setChannel(source.key, { cursor: '', boundary: channel.scan_end, scan_end: null, checked: now, error: null });
      return;
    }
    store.setChannel(source.key, { cursor, checked: now, error: null });
  }
}

export class Worker {
  constructor(store, { download, publish, admit = async () => true, now = Date.now }) {
    Object.assign(this, { store, download, publish, admit, now });
    this.busy = false;
  }
  async tick() {
    if (this.busy) return;
    this.busy = true;
    let job, media;
    try {
      if (!await this.admit()) return;
      job = this.store.next(this.now());
      if (!job) return;
      this.store.begin(job.id);
      media = await this.download(job);
      const paths = await this.publish(job, media);
      this.store.ready(job.id, paths);
    } catch (error) {
      if (job) {
        if (error?.code === 'video_not_ready') this.store.deferLive(job.id, this.now());
        else this.store.failed(job.id, error?.code || 'free_download_or_upload_failed', this.now());
      }
    } finally {
      await media?.cleanup?.().catch(() => {});
      this.busy = false;
    }
  }
}
