// Read-only: what a real browser requests on a Kol Halashon lesson page (runs on the GitHub runner).
import { execSync } from 'node:child_process';
execSync('npm i --no-save playwright-core@1.65.1 >/dev/null 2>&1 && npx playwright-core install --with-deps --only-shell chromium >/dev/null 2>&1');
const { chromium } = await import(process.cwd()+'/node_modules/playwright-core/index.mjs');
const b = await chromium.launch({ headless:true, args:['--no-sandbox','--autoplay-policy=no-user-gesture-required'] });
for (const url of ['https://www.kolhalashon.com/he/regularSite/playShiur/1193473/-1/0/false', 'https://www.yutorah.org/lectures/1103850/']) {
  const ctx = await b.newContext({ locale:'he-IL' }); const p = await ctx.newPage();
  const reqs=[];
  ctx.on('response', r=>{ const u=r.url(); if(!/\.(png|jpe?g|gif|svg|woff2?|css|ico)(\?|$)/i.test(u)) reqs.push(r.status()+' '+(r.headers()['content-type']||'').slice(0,30)+' '+u.slice(0,160)); });
  await p.goto(url,{waitUntil:'domcontentloaded',timeout:30000}).catch(e=>console.log('goto',e.message));
  await p.waitForTimeout(6000);
  for (const sel of ['[class*="play" i]','button','audio','video']) { const el=await p.$(sel).catch(()=>null); if(el){ console.log('click',sel); await el.click({force:true,timeout:2000}).catch(()=>{}); await p.waitForTimeout(4000);} }
  const html = await p.content(); console.log('PAGE',url,'title',await p.title(),'len',html.length, 'audio tags', (html.match(/<(audio|video)[^>]*>/gi)||[]).slice(0,3));
  console.log(reqs.filter(x=>!/google|facebook|doubleclick|analytics|gtm|hotjar/i.test(x)).slice(0,80).join('\n'));
  await ctx.close();
}
await b.close();
