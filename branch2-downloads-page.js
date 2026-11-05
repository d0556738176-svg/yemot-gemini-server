// Download page: the "אודיו" and "וידאו" folders with every file under its
// full Hebrew name. Yemot's own download erases Hebrew letters from the file
// name (its server sends "filename=_ _ _"); this page streams the same file
// from Yemot with a proper UTF-8 file name (RFC 6266 / 5987).
//
// Login: the browser asks for the Yemot system number and its password (the
// same as the Yemot site). They are checked by Yemot itself on every use, so
// no new password exists anywhere.
import { createHash } from 'node:crypto';
import { Readable } from 'node:stream';

const BASE = 'https://www.call2all.co.il/ym/api';
export const ROOTS = ['אודיו', 'וידאו'];
const MIME = { flac: 'audio/flac', m4a: 'audio/mp4', mp3: 'audio/mpeg', wav: 'audio/wav', mp4: 'video/mp4', srt: 'application/x-subrip' };

export function allowedPath(p) {
  const m = /^ivr2:\/([^/]+)\/([^/]+)$/.exec(String(p || ''));
  if (!m || m[2].includes('..')) return false;
  return ROOTS.some(r => m[1] === r || new RegExp('^' + r + '_\\d+$').test(m[1]));
}

// "מוטי_שטיינמץ_הנשמה_בקרבי.flac" -> "מוטי שטיינמץ הנשמה בקרבי.flac"
export function niceName(file) {
  const m = /^(.*)\.([^.]+)$/.exec(String(file));
  const stem = (m ? m[1] : String(file)).replace(/_+/g, ' ').trim();
  return m ? stem + '.' + m[2] : stem;
}

export function contentDisposition(name) {
  const ascii = name.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_');
  return 'attachment; filename="' + ascii + '"; filename*=UTF-8\'\'' + encodeURIComponent(name).replace(/['()]/g, c => '%' + c.charCodeAt(0).toString(16).toUpperCase());
}

function credentials(req) {
  const h = String(req.get('authorization') || '');
  if (!h.startsWith('Basic ')) return null;
  const raw = Buffer.from(h.slice(6), 'base64').toString('utf8');
  const i = raw.indexOf(':');
  if (i < 1) return null;
  const user = raw.slice(0, i).replace(/[^0-9]/g, ''), pass = raw.slice(i + 1);
  return user && pass ? user + ':' + pass : null;
}

export function registerDownloadsPage(app, { fetchImpl = fetch, log = console, expectedSystem = process.env.YEMOT_API_USERNAME } = {}) {
  const ok = new Map(); // credential hash -> valid until
  const fails = new Map(); // ip -> [count, since]
  const deny = res => res.status(401).set('WWW-Authenticate', 'Basic realm="Yemot downloads", charset="UTF-8"').type('html')
    .send('<!doctype html><meta charset="utf-8"><p dir="rtl">יש להיכנס עם מספר המערכת בימות והסיסמה שלה.</p>');
  async function auth(req, res) {
    const ip = req.ip || '';
    const f = fails.get(ip);
    if (f && f[0] >= 10 && Date.now() - f[1] < 15 * 60 * 1000) { res.status(429).send('Too many attempts'); return null; }
    const token = credentials(req);
    if (!token) { deny(res); return null; }
    const sys = String(expectedSystem || '').replace(/[^0-9]/g, '');
    if (sys && token.split(':')[0] !== sys) { fails.set(ip, [(f?.[0] || 0) + 1, f?.[1] || Date.now()]); deny(res); return null; }
    const h = createHash('sha256').update(token).digest('hex');
    if ((ok.get(h) || 0) > Date.now()) return token;
    const j = await (await fetchImpl(BASE + '/GetIVR2Dir?' + new URLSearchParams({ token, path: 'ivr2:/' }), { signal: AbortSignal.timeout(15000) })).json().catch(() => null);
    if (j?.responseStatus !== 'OK') { fails.set(ip, [(f?.[0] || 0) + 1, f?.[1] || Date.now()]); deny(res); return null; }
    ok.set(h, Date.now() + 30 * 60 * 1000);
    fails.delete(ip);
    return token;
  }
  const dir = async (token, path) => (await (await fetchImpl(BASE + '/GetIVR2Dir?' + new URLSearchParams({ token, path }), { signal: AbortSignal.timeout(20000) })).json().catch(() => null));

  app.get('/downloads', async (req, res) => {
    const token = await auth(req, res); if (!token) return;
    try {
      const root = await dir(token, 'ivr2:/');
      const folders = (root?.dirs || []).map(d => String(d.name || '').replace(/^.*\//, '')).filter(n => ROOTS.some(r => n === r || new RegExp('^' + r + '_\\d+$').test(n))).sort();
      const sections = [];
      for (const folder of folders) {
        const j = await dir(token, 'ivr2:/' + folder);
        const files = (j?.files || []).filter(x => /\.(flac|m4a|mp3|mp4|srt|wav)$/i.test(x.name || ''))
          .sort((a, b) => String(b.mtime || b.date || '').localeCompare(String(a.mtime || a.date || '')) || String(a.name).localeCompare(String(b.name), 'he'));
        sections.push({ folder, files });
      }
      const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
      const mb = n => n ? (Number(n) / 1048576).toFixed(1) + ' MB' : '';
      const rows = sections.map(s => '<h2>' + esc(s.folder) + ' <small>(' + s.files.length + ')</small></h2><ul>' +
        s.files.map(f => { const path = 'ivr2:/' + s.folder + '/' + f.name; return '<li data-n="' + esc(niceName(f.name)) + '"><a href="/downloads/file?path=' + encodeURIComponent(path) + '">' + esc(niceName(f.name)) + '</a> <small>' + mb(f.size) + '</small></li>'; }).join('') + '</ul>').join('');
      res.set('Cache-Control', 'no-store').type('html').send('<!doctype html><html lang="he" dir="rtl"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>הורדות</title>' +
        '<style>body{font-family:Arial,sans-serif;max-width:900px;margin:20px auto;padding:0 12px;line-height:1.6}h1{font-size:24px}h2{font-size:19px;margin-top:24px;border-bottom:1px solid #ccc}ul{list-style:none;padding:0}li{padding:6px 0;border-bottom:1px solid #eee}a{color:#0645ad;text-decoration:none;font-size:17px}small{color:#666;margin-right:8px}input{width:100%;padding:8px;font-size:16px;box-sizing:border-box}</style></head><body>' +
        '<h1>הורדות מהמערכת</h1><p>כל קובץ יורד בשמו המלא בעברית.</p><input id="q" placeholder="חיפוש לפי שם" oninput="for(const li of document.querySelectorAll(\'li\'))li.style.display=li.dataset.n.includes(this.value)?\'\':\'none\'">' + rows + '</body></html>');
    } catch (e) {
      log.warn?.('[DOWNLOADS PAGE] list failed', { message: String(e?.message || e).slice(0, 160) });
      res.status(502).type('html').send('<meta charset="utf-8"><p dir="rtl">לא הצלחתי לקרוא את התיקיות מימות כרגע. נסה שוב בעוד רגע.</p>');
    }
  });

  app.get('/downloads/file', async (req, res) => {
    const token = await auth(req, res); if (!token) return;
    const path = String(req.query.path || '');
    if (!allowedPath(path)) return res.status(400).send('Bad path');
    try {
      const headers = {};
      if (req.get('range')) headers.Range = req.get('range');
      const ac = new AbortController();
      req.on('close', () => ac.abort());
      const r = await fetchImpl(BASE + '/DownloadFile?' + new URLSearchParams({ token, path }), { headers, signal: ac.signal });
      const type = String(r.headers.get('content-type') || '');
      if (!r.ok || !r.body || /json/.test(type)) return res.status(404).type('html').send('<meta charset="utf-8"><p dir="rtl">הקובץ לא נמצא בימות.</p>');
      const file = path.slice(path.lastIndexOf('/') + 1);
      const ext = (/\.([^.]+)$/.exec(file)?.[1] || '').toLowerCase();
      res.status(r.status);
      res.set('Content-Type', MIME[ext] || 'application/octet-stream');
      res.set('Content-Disposition', contentDisposition(niceName(file)));
      for (const h of ['content-length', 'content-range', 'accept-ranges', 'last-modified']) if (r.headers.get(h)) res.set(h, r.headers.get(h));
      log.info?.('[DOWNLOADS PAGE] file', { path, status: r.status, bytes: r.headers.get('content-length') });
      Readable.fromWeb(r.body).on('error', () => res.destroy()).pipe(res);
    } catch (e) {
      if (!res.headersSent) res.status(502).send('Download failed');
      log.warn?.('[DOWNLOADS PAGE] file failed', { path, message: String(e?.message || e).slice(0, 160) });
    }
  });
}
