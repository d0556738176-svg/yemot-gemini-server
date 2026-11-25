const j=await fetch('https://ext2.176-97-205-41.sslip.io/news-status').then(r=>r.json()).catch(e=>({err:String(e)}));
const s=JSON.stringify(j); console.log(s.length);
console.log(JSON.stringify({archives:j.index?.archives??j.archives, next:j.index?.next??j.next, count:(j.items||j.files||[]).length, keys:Object.keys(j)}));
console.log(s.slice(0,2500));
