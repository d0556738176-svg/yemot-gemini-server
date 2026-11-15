// Announce measured stages, never estimate provider download percentages.
export function progressAnnouncement(progress={},last={},now=Date.now()){
  const stage=progress.stage||'checking';
  const bytes=Number(progress.bytes),total=Number(progress.totalBytes);
  const measured=stage==='transferring'&&Number.isFinite(total)&&total>0&&Number.isFinite(bytes)&&bytes>=0;
  const percent=measured?Math.min(99,Math.floor(bytes/total*100)):null;
  const providerMeasured=stage==='provider'&&typeof progress.providerPercent==='number'&&Number.isFinite(progress.providerPercent)&&progress.providerPercent>=0&&progress.providerPercent<=99;
  const providerPercent=providerMeasured?Math.floor(progress.providerPercent):null;
  const bucket=providerMeasured?Math.floor(providerPercent/10)*10:percent===null?null:Math.floor(percent/20)*20;
  const done=Number(progress.completed)||0,count=Number(progress.total)||0;
  const facts=stage==='provider'&&!providerMeasured?providerFactsKey(progress,now):'';
  const masterPct=stage==='converting'&&Number.isFinite(Number(progress.percent))?Math.floor(Number(progress.percent)/10)*10:'';
  const key=stage+':'+(stage==='transferring'||stage==='provider'?String(bucket)+':'+Boolean(progress.providerStale)+':'+facts:stage==='uploading'?done:stage==='converting'?masterPct:'');
  if(last.key===key&&now-last.at<35000)return null;
  // Avoid speaking every individual chunk or percentage change.
  if(last.stage===stage&&now-last.at<12000)return null;
  let text;
  switch(stage){
    case 'provider':
      if(providerMeasured){
        text=(progress.providerStale?'בדיווח האחרון מהמנוע הורדו ':'לפי הדיווח האחרון מהמנוע הורדו ')+providerPercent+' אחוז מקובץ המקור ביוטיוב. '+(progress.providerStale?'ממתין לעדכון חדש. ':'')+'הקובץ עדיין אינו מוכן להשמעה.';break;
      }
      text=providerFactsText(progress,now,last.stage!=='provider');break;
    case 'transferring':
      if(progress.direct){text=measured?'מוריד ישירות מיוטיוב. הורדו '+percent+' אחוז מהקובץ. נא להמתין.':'מוריד ישירות מיוטיוב. ההורדה נמשכת, נא להמתין.';break;}
      text=measured?'קובץ השמע מוכן במנוע וכעת מועבר לשרת. התקבלו '+percent+' אחוז מהקובץ. נא להמתין.'
        :'קובץ השמע מוכן במנוע וכעת מועבר לשרת. ההעברה נמשכת, נא להמתין.';break;
    case 'downloaded':
      text='הורדת קובץ השמע הושלמה במאה אחוז. כעת מכין אותו להשמעה בטלפון.';break;
    case 'converting':
      text=Number.isFinite(Number(progress.percent))
        ?'מכוונן את העוצמה והבהירות להשמעה נעימה בטלפון. הושלמו '+Math.floor(Number(progress.percent))+' אחוז מהכוונון. נא להמתין.'
        :'הורדת קובץ השמע הושלמה במאה אחוז. כעת מכוונן את העוצמה והבהירות להשמעה נעימה בטלפון. נא להמתין.';break;
    case 'preparing':
      text='כעת ממיר ומעלה את השמע במקביל. הושלמו ואומתו '+done+' חלקים. ההכנה נמשכת.';break;
    case 'uploading':
      text=count===1?'קובץ השמע מוכן ומותאם לטלפון. כעת מעלה אותו לימות כקובץ אחד מלא. נא להמתין.'
        :'כעת מעלה את חלקי השמע לימות.'+(count?' הושלמו ואומתו '+done+' מתוך '+count+' חלקים.':'')+' נא להמתין.';break;
    case 'verifying':
      text='השמע הועלה. כעת מבצע בדיקה סופית ושומר להשמעות חוזרות.';break;
    case 'cached':
      text='מצאתי עותק שמור של הסרטון. בודק את הקבצים לפני ההשמעה, ללא הורדה נוספת.';break;
    default:text='בודק אם הסרטון כבר שמור ומכין את ההשמעה. אעדכן אותך בהתקדמות. נא להמתין על הקו.';
  }
  return {text,state:{key,stage,at:now}};
}


// Engine stage without a percentage (the native engine prints none while it
// downloads): say only what is really known — how long the engine has been
// working (from its own run start time) and which route attempt it is on.
function minutesHebrew(n){return n===1?'דקה':n===2?'שתי דקות':n+' דקות';}
const ORD=['','ראשון','שני','שלישי','רביעי','חמישי','שישי','שביעי','שמיני','תשיעי','עשירי'];
function providerElapsedMin(progress,now){
  const t=Date.parse(progress.providerStartedAt||'');
  return Number.isFinite(t)&&now>=t?Math.floor((now-t)/60000):null;
}
export function providerFactsKey(progress,now){
  const a=progress.providerAttempts;
  return String(providerElapsedMin(progress,now))+':'+(a?a.current+'/'+a.blocked:'');
}
export function providerFactsText(progress,now=Date.now(),explain=true){
  const parts=['מנוע ההורדה מוריד עכשיו את הסרטון מיוטיוב.'];
  const min=providerElapsedMin(progress,now);
  if(min!==null)parts.push(min<1?'ההורדה במנוע התחילה לפני פחות מדקה.':'ההורדה במנוע נמשכת כבר '+minutesHebrew(min)+'.');
  const a=progress.providerAttempts;
  if(a&&a.blocked>0&&a.last!=='ok'){
    parts.push((a.blocked===1?'נתיב הורדה אחד נחסם':a.blocked+' נתיבי הורדה נחסמו')+' על ידי יוטיוב, והמנוע עבר לנתיב אחר.');
    parts.push('זה הניסיון ה'+(ORD[a.current]||('מספר '+a.current))+(a.max?' מתוך '+a.max:'')+'.');
  }
  parts.push(explain?'אין דיווח אחוזים מהמנוע הזה בזמן ההורדה, ולכן אדווח אחוזים אמיתיים מהרגע שהקובץ יגיע לשרת. נא להמתין על הקו.':'נא להמתין על הקו.');
  return parts.join(' ');
}
