// The owner's work browser (25.11): a real browser that runs on this server,
// seen and driven from his own Chrome at /browser. Approved by NetFree for his
// work only, so it opens only the system's work sites (an allowlist); any other
// address is refused. Behind a password the owner sets himself
// (OWNER_BROWSER_PASSWORD, at least 16 characters, via deploy/vps/set-key.sh);
// with no password set the page stays closed. One session at a time; the
// browser closes itself after 15 idle minutes. Nothing is recorded.
import { randomBytes, timingSafeEqual, createHash } from 'node:crypto';
import { browserPath } from './browser-media.js';

const W = 1280, H = 800, IDLE_MS = 15 * 60000, SESSION_MS = 12 * 3600000;
// Work sites: the host or any sub-host of these. OWNER_BROWSER_SITES adds more (comma separated).
const BASE_SITES = ['call2all.co.il', 'yemot.co.il', 'empire.co.il', 'empire-il.com', 'github.com', 'githubusercontent.com',
  'acemusic.ai', 'huggingface.co', 'hf.space', 'aistudio.google.com', 'accounts.google.com', 'console.groq.com', '176-97-205-41.sslip.io', '88-214-55-82.sslip.io'];
export function workSites(env = process.env) {
  return [...BASE_SITES, ...String(env.OWNER_BROWSER_SITES || '').split(',').map(s => s.trim().toLowerCase()).filter(s => /^[a-z0-9.-]+\.[a-z]{2,}$/.test(s))];
}
export function allowedUrl(u, env = process.env) {
  let url;
  try { url = new URL(String(u)); } catch { return false; }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return url.protocol === 'about:';
  const h = url.hostname.toLowerCase();
  return workSites(env).some(s => h === s || h.endsWith('.' + s));
}

const sessions = new Map(); // token -> expires
let state = null; // { browser, context, page, lastUse, blocked }
let idleTimer = null;

function passwordOk(given, env = process.env) {
  const real = String(env.OWNER_BROWSER_PASSWORD || '');
  if (real.length < 16) return false;
  const a = createHash('sha256').update(String(given || '')).digest(), b = createHash('sha256').update(real).digest();
  return timingSafeEqual(a, b);
}
function tokenOf(req) {
  const m = String(req.headers.cookie || '').match(/(?:^|;\s*)ob=([a-f0-9]{64})/);
  return m ? m[1] : '';
}
function authed(req) {
  const t = tokenOf(req), exp = t && sessions.get(t);
  if (!exp) return false;
  if (Date.now() > exp) { sessions.delete(t); return false; }
  return true;
}

async function ensurePage() {
  clearTimeout(idleTimer);
  idleTimer = setTimeout(closeBrowser, IDLE_MS); idleTimer.unref?.();
  if (state?.browser?.isConnected() && !state.page.isClosed()) { state.lastUse = Date.now(); return state; }
  await closeBrowser();
  const { chromium } = await import('playwright-core');
  const browser = await chromium.launch({ executablePath: browserPath(), headless: true,
    args: ['--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu', '--no-zygote', '--mute-audio', '--js-flags=--max-old-space-size=384'] });
  const context = await browser.newContext({ viewport: { width: W, height: H }, locale: 'he-IL', timezoneId: 'Asia/Jerusalem',
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36' });
  const page = await context.newPage();
  state = { browser, context, page, lastUse: Date.now(), blocked: '' };
  // Only the work sites can be opened as pages (their own images and scripts load normally).
  await context.route('**/*', route => {
    const r = route.request();
    if (r.isNavigationRequest() && r.frame() === page.mainFrame() && !allowedUrl(r.url())) {
      state.blocked = (() => { try { return new URL(r.url()).hostname; } catch { return '?'; } })();
      return route.abort('blockedbyclient');
    }
    return route.continue();
  });
  // A link that opens a new window opens here instead (if allowed).
  context.on('page', async p => {
    if (p === page) return;
    const u = p.url();
    await p.close().catch(() => {});
    if (u && allowedUrl(u)) page.goto(u, { timeout: 30000 }).catch(() => {});
  });
  await page.goto('https://www.call2all.co.il/', { timeout: 30000, waitUntil: 'domcontentloaded' }).catch(() => {});
  return state;
}
export async function closeBrowser() {
  const s = state; state = null;
  await s?.browser?.close().catch(() => {});
}

const PAGE = `<!DOCTYPE html><html lang="he" dir="rtl"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>דפדפן העבודה</title><link rel="stylesheet" href="/browser/app.css"></head><body>
<div id="login" hidden><h1>דפדפן העבודה</h1><p id="lmsg">הקלד את הסיסמה:</p><input id="pw" type="password" autocomplete="current-password"><button id="go">כניסה</button></div>
<div id="ui" hidden><div class="bar"><button id="back" title="אחורה">→</button><button id="reload" title="רענון">⟳</button>
<input id="addr" dir="ltr" spellcheck="false"><button id="open">פתח</button><span id="note"></span><button id="out">יציאה</button></div>
<div class="bar"><input id="text" placeholder="הקלד כאן טקסט ולחץ שלח (נכנס לשדה שלחצת עליו)"><button id="send">שלח</button>
<button data-k="Enter">אנטר</button><button data-k="Backspace">מחק</button><button data-k="Tab">טאב</button>
<button data-s="-500">למעלה</button><button data-s="500">למטה</button></div>
<img id="screen" alt="מסך הדפדפן"></div><script src="/browser/app.js"></script></body></html>`;
const CSS = `body{margin:0;font-family:Arial,sans-serif;background:#f3f4f6}#login{max-width:360px;margin:80px auto;background:#fff;padding:24px;border-radius:10px}
#login input{width:100%;font-size:18px;padding:8px;box-sizing:border-box;margin:8px 0}button{font-size:15px;padding:6px 12px;margin:2px;cursor:pointer}
.bar{display:flex;gap:4px;align-items:center;padding:6px;background:#fff;border-bottom:1px solid #ddd;flex-wrap:wrap}#addr{flex:1;min-width:260px;font-size:15px;padding:6px}
#text{flex:1;min-width:200px;font-size:15px;padding:6px}#note{color:#b45309;font-size:14px}#screen{display:block;max-width:100%;cursor:pointer;margin:0 auto;background:#fff}`;
const JS = `const $=id=>document.getElementById(id);let busy=false,timer=null;
async function api(p,b){const r=await fetch(p,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(b||{})});if(r.status===401){show(false);throw 0}return r.json().catch(()=>({}))}
function show(inside){$('login').hidden=inside;$('ui').hidden=!inside;if(inside)loop()}
async function refresh(){if(busy)return;busy=true;try{const i=await fetch('/browser/info');if(i.status===401)return show(false);const j=await i.json().catch(()=>({}));
await new Promise(ok=>{const im=new Image();im.onload=()=>{$('screen').src=im.src;ok()};im.onerror=ok;im.src='/browser/shot?'+Date.now()});
if(document.activeElement!==$('addr'))$('addr').value=j.url||'';$('note').textContent=j.blocked?('האתר '+j.blocked+' לא ברשימת אתרי העבודה'):'';}finally{busy=false}}
function loop(){clearInterval(timer);refresh();timer=setInterval(()=>{if(!document.hidden)refresh()},1500)}
async function act(b){await api('/browser/act',b).catch(()=>{});setTimeout(refresh,400)}
$('go').onclick=async()=>{const r=await fetch('/browser/login',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({password:$('pw').value})});
if(r.ok){$('pw').value='';show(true)}else{const j=await r.json().catch(()=>({}));$('lmsg').textContent=j.message||'סיסמה שגויה'}};
$('pw').onkeydown=e=>{if(e.key==='Enter')$('go').click()};
$('screen').onclick=e=>{const r=e.target.getBoundingClientRect();act({type:'click',x:Math.round((e.clientX-r.left)*${W}/r.width),y:Math.round((e.clientY-r.top)*${H}/r.height)})};
$('screen').onwheel=e=>{e.preventDefault();act({type:'scroll',dy:Math.round(e.deltaY)})};
$('open').onclick=()=>{let u=$('addr').value.trim();if(u&&!/^https?:/i.test(u))u='https://'+u;act({type:'go',url:u})};
$('addr').onkeydown=e=>{if(e.key==='Enter')$('open').click()};
$('send').onclick=()=>{act({type:'text',text:$('text').value});$('text').value=''};
$('text').onkeydown=e=>{if(e.key==='Enter')$('send').click()};
$('back').onclick=()=>act({type:'back'});$('reload').onclick=()=>act({type:'reload'});
document.querySelectorAll('[data-k]').forEach(b=>b.onclick=()=>act({type:'key',key:b.dataset.k}));
document.querySelectorAll('[data-s]').forEach(b=>b.onclick=()=>act({type:'scroll',dy:Number(b.dataset.s)}));
$('out').onclick=async()=>{await api('/browser/logout');show(false)};
fetch('/browser/info').then(r=>show(r.ok)).catch(()=>show(false));`;

export function mountOwnerBrowser(app, rateLimit) {
  const guard = (req, res, next) => authed(req) ? next() : res.status(401).json({ ok: false });
  app.get('/browser', (req, res) => res.type('html').set('cache-control', 'no-store').send(PAGE));
  app.get('/browser/app.css', (req, res) => res.type('css').send(CSS));
  app.get('/browser/app.js', (req, res) => res.type('js').send(JS));
  app.post('/browser/login', rateLimit(6, 15 * 60000, 'owner-browser-login'), (req, res) => {
    if (String(process.env.OWNER_BROWSER_PASSWORD || '').length < 16) return res.status(403).json({ ok: false, message: 'עדיין לא נקבעה סיסמה לדפדפן' });
    if (!passwordOk(req.body?.password)) { console.warn('[OWNER_BROWSER] wrong password'); return res.status(401).json({ ok: false, message: 'סיסמה שגויה' }); }
    const t = randomBytes(32).toString('hex');
    sessions.clear(); // one session at a time
    sessions.set(t, Date.now() + SESSION_MS);
    console.info('[OWNER_BROWSER] signed in');
    res.set('Set-Cookie', 'ob=' + t + '; Path=/browser; HttpOnly; Secure; SameSite=Strict; Max-Age=' + SESSION_MS / 1000).json({ ok: true });
  });
  app.post('/browser/logout', (req, res) => { sessions.delete(tokenOf(req)); closeBrowser(); res.set('Set-Cookie', 'ob=; Path=/browser; Max-Age=0').json({ ok: true }); });
  app.get('/browser/info', guard, async (req, res) => {
    const s = state;
    res.set('cache-control', 'no-store').json({ ok: true, url: s?.page && !s.page.isClosed() ? s.page.url() : '', blocked: s?.blocked || '' });
  });
  app.get('/browser/shot', rateLimit(120, 60000, 'owner-browser-shot'), guard, async (req, res) => {
    try {
      const s = await ensurePage();
      const img = await s.page.screenshot({ type: 'jpeg', quality: 70, timeout: 15000 });
      res.type('image/jpeg').set('cache-control', 'no-store').send(img);
    } catch (e) { res.status(503).json({ ok: false }); }
  });
  app.post('/browser/act', rateLimit(240, 60000, 'owner-browser-act'), guard, async (req, res) => {
    const b = req.body || {};
    try {
      const s = await ensurePage(), p = s.page;
      s.blocked = '';
      if (b.type === 'click') await p.mouse.click(Math.max(0, Math.min(W, Number(b.x) || 0)), Math.max(0, Math.min(H, Number(b.y) || 0)));
      else if (b.type === 'scroll') await p.mouse.wheel(0, Math.max(-3000, Math.min(3000, Number(b.dy) || 0)));
      else if (b.type === 'text') await p.keyboard.insertText(String(b.text || '').slice(0, 2000));
      else if (b.type === 'key' && ['Enter', 'Backspace', 'Tab', 'Escape'].includes(b.key)) await p.keyboard.press(b.key);
      else if (b.type === 'back') await p.goBack({ timeout: 15000 }).catch(() => {});
      else if (b.type === 'reload') await p.reload({ timeout: 20000 }).catch(() => {});
      else if (b.type === 'go') {
        if (!allowedUrl(b.url)) { s.blocked = (() => { try { return new URL(b.url).hostname; } catch { return String(b.url).slice(0, 40); } })(); return res.json({ ok: false, blocked: true }); }
        await p.goto(String(b.url), { timeout: 30000, waitUntil: 'domcontentloaded' }).catch(() => {});
      }
      res.json({ ok: true });
    } catch (e) { res.status(503).json({ ok: false }); }
  });
}
