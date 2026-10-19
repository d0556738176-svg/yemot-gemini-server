const PHONE_RE = /(?:0[2-489]-?\d{7}|0[57]\d-?\d{7}|07\d-?\d{7}|\*\d{3,5})/g;

export function buildPharmacySearchQueries(city) {
  const place=String(city||'').trim();
  if(!place) return [];
  return [
    'בתי מרקחת '+place+' כתובת טלפון',
    'בית מרקחת '+place+' מספר טלפון כתובת',
    'site:super-pharm.co.il/branches '+place+' סופר-פארם טלפון',
    'מכבי פארם או כללית פארם '+place+' טלפון'
  ];
}

function extractPhones(text) {
  return [...new Set((String(text||'').match(PHONE_RE)||[]).map(x=>x.trim()))].slice(0,2);
}

export function buildPharmacySearchAnswer({city='',results=[]}={}) {
  const place=String(city||'').trim();
  const seen=new Set();
  const items=(Array.isArray(results)?results:[])
    .filter(x=>String(x?.title||'').trim() && String(x?.url||'').trim())
    .map(x=>{
      const title=String(x.title).replace(/\s+/g,' ').trim();
      const snippet=String(x.snippet||'').replace(/\s+/g,' ').trim();
      const key=title.toLocaleLowerCase('he');
      if(seen.has(key)) return null;
      seen.add(key);
      return {title,snippet,phones:extractPhones(title+' '+snippet)};
    })
    .filter(Boolean)
    .slice(0,5);
  if(!items.length) {
    return 'לא הצלחתי לאמת כרגע רשימה של בתי מרקחת ב'+place+'. לא אמסור שמות או מספרי טלפון שלא מצאתי במקור. אפשר לנסות שוב, או לבקש בית מרקחת של קופת חולים מסוימת.';
  }
  const lines=items.map((x,i)=>{
    const phone=x.phones.length?' מספר טלפון: '+x.phones.join(' או ')+'.':' לא נמצא מספר טלפון בקטע המקור שקיבלתי.';
    const detail=x.snippet? ' פרטים מהמקור: '+x.snippet.slice(0,180)+'.':'';
    return (i+1)+'. '+x.title+'.'+phone+detail;
  });
  return 'מצאתי את התוצאות הבאות לחיפוש בתי מרקחת ב'+place+'. '+lines.join(' ')+' הפרטים נלקחו מתוצאות החיפוש; לפני הגעה כדאי לאמת כתובת ושעות פתיחה מול הסניף.';
}
