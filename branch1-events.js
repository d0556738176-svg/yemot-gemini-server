import { extractExplicitLocation } from './business-location.js';
import { readSinglePublicWebsitePage } from './website-reader.js';

const months=['ינואר','פברואר','מרץ','אפריל','מאי','יוני','יולי','אוגוסט','ספטמבר','אוקטובר','נובמבר','דצמבר'];
const dateRe=new RegExp('(?:(20\\d{2})-(\\d{2})-(\\d{2})|([0-3]?\\d)[./]([01]?\\d)[./](20\\d{2})|([0-3]?\\d)\\s+ב?('+months.join('|')+')\\s+(20\\d{2}))','gu');
const plain=s=>String(s||'').replace(/\[([^\]]+)\]\([^)]+\)/gu,'$1').replace(/https?:\/\/\S+/gu,' ').replace(/[*#_<>]/gu,' ').replace(/\s+/gu,' ').trim();

export function eventDateRange(question, now=new Date()) {
  const p=Object.fromEntries(new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Jerusalem',year:'numeric',month:'2-digit',day:'2-digit'}).formatToParts(now).map(x=>[x.type,x.value]));
  const today=Date.UTC(+p.year,+p.month-1,+p.day), day=86400000;
  let start=today, end=today+day;
  const explicit=String(question).match(/(?:(20\d{2})-(\d{2})-(\d{2})|(\d{1,2})[./](\d{1,2})(?:[./](20\d{2}))?)/u);
  if(explicit){start=Date.UTC(+(explicit[1]||explicit[6]||p.year),+(explicit[2]||explicit[5])-1,+(explicit[3]||explicit[4]));end=start+day;}
  else if(/מחר/u.test(question)){start+=day;end=start+day;}
  else if(/סוף\s*השבוע/u.test(question)){const weekday=new Date(today).getUTCDay();start+=((5-weekday+7)%7)*day;end=start+2*day;}
  else if(/השבוע/u.test(question))end=start+7*day;
  return {start,end,today:new Date(today).toISOString().slice(0,10),now};
}

function datesIn(text) {
  return [...String(text).matchAll(dateRe)].map(m=>{
    const year=+(m[1]||m[6]||m[9]),month=m[8]?months.indexOf(m[8])+1:+(m[2]||m[5]),day=+(m[3]||m[4]||m[7]);
    const stamp=Date.UTC(year,month-1,day),d=new Date(stamp);
    return d.getUTCMonth()===month-1&&d.getUTCDate()===day?{stamp,index:m.index,length:m[0].length,text:m[0]}:null;
  }).filter(Boolean);
}

export function extractDatedEvents(page,city,range) {
  const candidates=[];
  for(const link of page.sourceLinks||page.links||[]) candidates.push({text:link.content,url:link.url});
  for(const m of String(page.content||'').matchAll(/\[([^\]]{5,2000})\]\((https?:\/\/[^)\s]+)\)/gu))candidates.push({text:m[1],url:m[2]});
  // Plain-text extraction often preserves each calendar row on one line.
  const lines=String(page.content||'').split(/\n+/u).map(plain).filter(Boolean);
  for(let i=0;i<lines.length;i++)if(datesIn(lines[i]).length===1) {
    let text=lines[i];
    if(!/\d{1,2}:\d{2}/u.test(text))text+=' '+(lines[i+1]||'')+' '+(lines[i+2]||'');
    if(datesIn(text).length!==1)continue;
    const date=datesIn(text)[0];
    if(date.index<8 && i>0&&!datesIn(lines[i-1]).length)text=lines[i-1]+' '+text;
    candidates.push({text,url:page.url});
  }
  const out=[];
  for(const row of candidates) {
    const text=plain(row.text), dates=datesIn(text);
    if(dates.length!==1)continue; // Never attach a date from one event to another.
    const d=dates[0];if(d.stamp<range.start||d.stamp>=range.end)continue;
    if(/פורסם|תאריך פרסום|עודכן/u.test(text)&&!/תאריך האירוע|יתקיים|תתקיים/u.test(text))continue;
    const time=text.match(/(?:בשעה\s*)?([0-2]?\d):([0-5]\d)/u);
    if(!time||+time[1]>23)continue;
    const prefix=text.slice(0,d.index).replace(/(?:ביום\s*)?(?:יום\s*)?(?:ראשון|שני|שלישי|רביעי|חמישי|שישי|שבת)[, ]*$/u,'').trim();
    let title=prefix.replace(/^(?:\d{1,2}\s+)?(?:ינואר|פברואר|מרץ|אפריל|מאי|יוני|יולי|אוגוסט|ספטמבר|אוקטובר|נובמבר|דצמבר)\s+/u,'');
    if(title.includes('פרטים נוספים'))title=title.split('פרטים נוספים').at(-1).trim();
    // Drop venue/category suffixes from the event name while preserving them separately.
    const venueMatch=title.match(/(היכל (?:התרבות|תרבות)[^,]*|מרכז קהילתי[^,]*|מועדון הנוער[^,]*)$/u);
    const after=text.slice(d.index+d.length).replace(/^(?:\s*בשעה)?\s*\d{1,2}:\d{2}\s*/u,'').replace(/\s*לפרטים נוספים.*$/u,'').trim();
    const venue=venueMatch?.[1]||after;
    if(venueMatch)title=title.slice(0,venueMatch.index).trim();
    title=title.replace(/\s+(?:תיאטרון|ילדים|מוזיקה|נשים|סרטים|בידור)$/u,'').trim();
    if(title.length<3||title.length>180)continue;
    const sourceText=[page.title,page.content].join(' ');
    if(!sourceText.includes(city))continue;
    out.push({name:title,date:new Date(d.stamp).toISOString().slice(0,10),time:time[1].padStart(2,'0')+':'+time[2],venue:venue.slice(0,160),url:row.url||page.url,sourceUrl:page.url});
  }
  return [...new Map(out.map(e=>[[e.name,e.date,e.time].join('|'),e])).values()];
}

export async function findBranch1Events(q,search,{read=readSinglePublicWebsitePage,extract,now=new Date()}={}) {
  const city=extractExplicitLocation(q).city;
  if(!city)return 'באיזו עיר לחפש את האירועים?';
  if(!/(היום|מחר|הערב|השבוע|סוף השבוע|\d{1,2}[./]\d{1,2}|20\d{2}-\d{2}-\d{2})/u.test(q))return 'לחפש לך הופעה או פעילות תרבות ב'+city+' להיום, למחר או להמשך השבוע?';
  const range=eventDateRange(q,now);
  let urls=city==='בית שמש'?['https://www.betshemesh.muni.il/events/','https://betshemesh.smarticket.co.il/']:[];
  if(!urls.length){
    const results=await search(q+' '+range.today+' לוח אירועים רשמי',{timeoutMs:2200});
    urls=[...new Set(results.filter(r=>[r.title,r.snippet].join(' ').includes(city)).map(r=>r.url))].slice(0,3);
  }
  const reads=await Promise.allSettled(urls.map(async url=>{
    let page;try{page=await read({url,timeoutMs:2800});}catch{}
    if(extract && (!page || !extractDatedEvents(page,city,range).length)) {
      try{const extra=await extract(url,2500);if(extra&&extractDatedEvents(extra,city,range).length)page=extra;}catch{}
    }
    return page;
  }));
  if(!reads.some(r=>r.status==='fulfilled'&&r.value?.content))return 'לא הצלחתי לטעון כרגע את לוחות האירועים של '+city+'. זו תקלה בקריאת המקור, ולא אישור שאין אירועים בעיר.';
  let events=reads.flatMap(r=>r.status==='fulfilled'&&r.value?extractDatedEvents(r.value,city,range):[]);
  events=[...new Map(events.map(e=>[[e.name,e.date,e.time].join('|'),e])).values()].sort((a,b)=>(a.date+a.time).localeCompare(b.date+b.time));
  if(!events.length)return 'קראתי את לוחות האירועים הזמינים עבור '+city+', אבל לא מצאתי בהם אירוע עם תאריך ושעה שמתאימים לבקשה. אין בכך הוכחה שאין אירועים נוספים בעיר.';
  const p=Object.fromEntries(new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Jerusalem',year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',hourCycle:'h23'}).formatToParts(now).map(x=>[x.type,x.value]));
  const clock=p.hour+':'+p.minute;
  const selected=events.slice(0,5);
  return 'בלוחות האירועים של '+city+' מופיעים: '+selected.map(e=>{
    const ended=e.date===range.today&&e.time<clock;
    return e.name+', בתאריך '+e.date+', בשעה '+e.time+(e.venue?', ב'+e.venue:'')+(ended?'. שעת ההתחלה כבר עברה':'');
  }).join('. ')+'. המקור: '+[...new Set(selected.map(e=>new URL(e.sourceUrl).hostname))].join(', ')+'. יש לבדוק מול המארגן אם האירוע מתקיים ואם נותרו מקומות.';
}
