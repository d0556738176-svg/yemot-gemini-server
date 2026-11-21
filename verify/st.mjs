const s=await fetch('https://main.176-97-205-41.sslip.io/web-search-status').then(r=>r.json()).catch(e=>({err:String(e)}));
console.log(JSON.stringify(s.searches?.slice(-10)||s,null,1));
const d=await fetch('https://ext2.176-97-205-41.sslip.io/branch2-diag').then(r=>r.json()).catch(e=>({err:String(e)}));
console.log('ext2',d.commit,d.startedAt);
console.log(JSON.stringify((d.downloadEvents||[]).slice(-25).map(e=>[e.at,e.kind,e.id,e.ok,e.code||'',(e.message||e.saved||e.remote||'').slice(0,120)])));
console.log(JSON.stringify((d.webEvents||[]).slice(-12).map(e=>[e.at,e.where,e.ok,e.engine,(e.message||'').slice(0,100)])));
