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
  const key=stage+':'+(stage==='transferring'||stage==='provider'?String(bucket)+':'+Boolean(progress.providerStale):stage==='uploading'?done:'');
  if(last.key===key&&now-last.at<35000)return null;
  // Avoid speaking every individual chunk or percentage change.
  if(last.stage===stage&&now-last.at<12000)return null;
  let text;
  switch(stage){
    case 'provider':
      if(providerMeasured){
        text=(progress.providerStale?'בדיווח האחרון מהמנוע הורדו ':'לפי הדיווח האחרון מהמנוע הורדו ')+providerPercent+' אחוז מקובץ המקור ביוטיוב. '+(progress.providerStale?'ממתין לעדכון חדש. ':'')+'הקובץ עדיין אינו מוכן להשמעה.';break;
      }
      text='מנוע ההורדה מכין את קובץ השמע מיוטיוב. עדיין אין דיווח אחוזים מהמנוע. העבודה נמשכת, נא להמתין על הקו.';break;
    case 'transferring':
      text=measured?'קובץ השמע מוכן במנוע וכעת מועבר לשרת. התקבלו '+percent+' אחוז מהקובץ. נא להמתין.'
        :'קובץ השמע מוכן במנוע וכעת מועבר לשרת. ההעברה נמשכת, נא להמתין.';break;
    case 'downloaded':
      text='הורדת קובץ השמע הושלמה במאה אחוז. כעת מכין אותו להשמעה בטלפון.';break;
    case 'converting':
      text='הורדת קובץ השמע הושלמה במאה אחוז. כעת ממיר אותו לפורמט המתאים להשמעה בטלפון. נא להמתין.';break;
    case 'preparing':
      text='כעת ממיר ומעלה את השמע במקביל. הושלמו ואומתו '+done+' חלקים. ההכנה נמשכת.';break;
    case 'uploading':
      text='כעת מעלה את חלקי השמע לימות.'+(count?' הושלמו ואומתו '+done+' מתוך '+count+' חלקים.':'')+' נא להמתין.';break;
    case 'verifying':
      text='כל חלקי השמע הועלו. כעת מבצע בדיקה סופית ושומר להשמעות חוזרות.';break;
    case 'cached':
      text='מצאתי עותק שמור של הסרטון. בודק את הקבצים לפני ההשמעה, ללא הורדה נוספת.';break;
    default:text='בודק אם הסרטון כבר שמור ומכין את ההשמעה. אעדכן אותך בהתקדמות. נא להמתין על הקו.';
  }
  return {text,state:{key,stage,at:now}};
}

