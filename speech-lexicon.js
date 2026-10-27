// Generic correction of mis-heard Israeli names from speech recognition.
// Instead of one regex per mistake, every phrase in the transcript is compared against a
// lexicon of well-known entities using a Hebrew-aware consonant skeleton and a weighted
// edit distance, so new sound-alike mistakes are fixed without code changes.

export const ENTITY_LEXICON = [
  // banks
  'בנק פאגי','בנק הפועלים','בנק לאומי','בנק דיסקונט','בנק מזרחי טפחות','בנק איגוד','בנק יהב','בנק הדואר','בנק מסד','הבנק הבינלאומי','בנק אוצר החייל','בנק ירושלים','בנק מרכנתיל','בנק ישראל',
  // health, government
  'בית מרקחת','בתי מרקחת','בית חולים','מרכז רפואי','דואר ישראל',
  'כללית','מכבי שירותי בריאות','מאוחדת','לאומית','ביטוח לאומי','משרד הפנים','רשות המסים','מגן דוד אדום','משטרת ישראל','כבאות והצלה','משרד הבריאות','קופת חולים',
  // telecom, utilities
  'בזק','פרטנר','סלקום','פלאפון','הוט','יס','גולן טלקום','רמי לוי תקשורת','חברת החשמל','מקורות','רכבת ישראל','אגד','דן','אל על','ישראייר','ארקיע',
  // retail, pharmacies, food
  'סופר פארם','שופרסל','רמי לוי','ויקטורי','יוחננוף','מגה','אושר עד','טיב טעם','חצי חינם','סטופ מרקט','קרפור','ניו פארם','בי פארם','גוד פארם','איקאה','קניון עזריאלי','מקדונלדס','פיצה האט','דומינוס','ארומה','קפה גרג','קסטרו','פוקס','הום סנטר','אייס','מגה ספורט','ביג','חצי חינם',
  // insurance
  'הראל','מגדל','כלל ביטוח','הפניקס','מנורה מבטחים','איילון','שירביט','ביטוח ישיר','ליברה',
  // cities
  'רעננה','כפר סבא','הוד השרון','פתח תקווה','ראשון לציון','תל אביב','ירושלים','חיפה','באר שבע','נתניה','אשדוד','אשקלון','בני ברק','בית שמש','קרית גת','רחובות','מודיעין','חולון','בת ים','רמת גן','גבעתיים','הרצליה','אילת','טבריה','צפת'
];

const FINAL = {ך:'כ',ם:'מ',ן:'נ',ף:'פ',ץ:'צ'};
// Letters that speech recognition tends to confuse count as half-cost substitutions.
const CONFUSABLE = [['ב','פ'],['ק','כ'],['ס','ז'],['ס','צ'],['ד','ט'],['ג','ק'],['מ','נ'],['ר','ל'],['כ','ח']];
const CONFUSE=new Set(CONFUSABLE.flatMap(([a,b])=>[a+b,b+a]));

export function skeleton(text){
  let s=String(text||'').replace(/[֑-ׇ]/g,'').replace(/["'׳״`]/g,'');
  s=s.replace(/[ךםןףץ]/g,c=>FINAL[c]);
  s=s.replace(/[^א-ת]/g,'');
  s=s.replace(/ש/g,'ס').replace(/ת/g,'ט').replace(/ק/g,'ק');
  // matres lectionis and weak letters carry little sound information
  s=s.replace(/[אעהיו]/g,'');
  return s;
}

function distance(a,b){
  const n=a.length,m=b.length;
  const d=Array.from({length:n+1},(_,i)=>Array(m+1).fill(0).map((_,j)=>i===0?j:(j===0?i:0)));
  for(let i=1;i<=n;i++)for(let j=1;j<=m;j++){
    const sub=a[i-1]===b[j-1]?0:(CONFUSE.has(a[i-1]+b[j-1])?0.5:1);
    d[i][j]=Math.min(d[i-1][j]+1,d[i][j-1]+1,d[i-1][j-1]+sub);
  }
  return d[n][m];
}

const ENTRIES=ENTITY_LEXICON.map(name=>({name,words:name.split(' ').length,skel:skeleton(name)}))
  .filter(e=>e.skel.length>=4);

const PREFIXES='בלהמושכ';
const STOP=new Set(['של','את','עם','על','מה','איך','אני','זה','לי','לך','גם','או','אם','כל','לא','כן','יש','אין','הוא','היא']);
function firstOk(a,b){ return !!a&&!!b&&(a[0]===b[0]||CONFUSE.has(a[0]+b[0])); }

export function fuzzyCorrectEntities(text,{threshold=0.28}={}){
  const words=String(text||'').split(/\s+/).filter(Boolean);
  if(words.length<2) return String(text||'');
  const out=[];
  let i=0;
  while(i<words.length){
    let best=null;
    for(const e of ENTRIES){
      for(const len of [e.words-1,e.words,e.words+1]){
        if(len<1||i+len>words.length) continue;
        const parts=words.slice(i,i+len);
        if(STOP.has(parts[0])||STOP.has(parts[parts.length-1])) continue;
        const phrase=parts.join(' ');
        if(phrase===e.name){ best={e,len,score:0,prefix:'',exact:true}; break; }
        const variants=[{sk:skeleton(phrase),prefix:''}];
        if(PREFIXES.includes(phrase[0])&&phrase.length>3) variants.push({sk:skeleton(phrase.slice(1)),prefix:phrase[0]});
        for(const v of variants){
          if(v.sk.length<4||Math.abs(v.sk.length-e.skel.length)>2||!firstOk(v.sk,e.skel)) continue;
          const score=distance(v.sk,e.skel)/Math.max(v.sk.length,e.skel.length);
          const limit=e.words===1?0:(len===e.words?threshold:threshold*0.6);
          if(score<=limit&&(!best||score<best.score||(score===best.score&&len>best.len))) best={e,len,score,prefix:v.prefix};
        }
      }
      if(best?.exact) break;
    }
    if(best){ out.push((best.prefix||'')+best.e.name); i+=best.len; } else { out.push(words[i]); i++; }
  }
  return out.join(' ');
}

export function lexiconKeyterms(limit=80){
  return [...new Set(ENTITY_LEXICON)].slice(0,limit);
}
