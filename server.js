import express from 'express';
import crypto from 'node:crypto';
import { YemotRouter, ExitError } from 'yemot-router2';
import { GoogleGenerativeAI } from '@google/generative-ai';
import YemotApi from 'yemot-api';
import { searchYouTubeVideos, formatYouTubeChoices, getSelectedYouTubeVideo } from './youtube-ivr.js';
import { downloadAndUploadYouTubeAudio } from './youtube-playback.js';

const app = express();
app.disable('x-powered-by');
app.set('trust proxy', 1);
app.use(express.urlencoded({ extended: true, limit: '64kb' }));
app.use(express.json({ limit: '256kb' }));

// Security headers and conservative request limits.
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
  res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self'; frame-src https://www.youtube.com https://www.youtube-nocookie.com; frame-ancestors 'none'; img-src 'self' https://i.ytimg.com data:;");
  next();
});

const rateBuckets = new Map();
function rateLimit(maxRequests, windowMs, label) {
  return (req, res, next) => {
    const now = Date.now();
    const key = label + ':' + (req.ip || 'unknown');
    let bucket = rateBuckets.get(key);
    if (!bucket || now - bucket.startedAt >= windowMs) {
      bucket = { startedAt: now, count: 0 };
      rateBuckets.set(key, bucket);
    }
    bucket.count++;
    if (bucket.count > maxRequests) {
      res.setHeader('Retry-After', String(Math.max(1, Math.ceil((bucket.startedAt + windowMs - now) / 1000))));
      return res.status(429).json({ error: 'Too many requests' });
    }
    next();
  };
}
setInterval(() => {
  const cutoff = Date.now() - 10 * 60 * 1000;
  for (const [key, bucket] of rateBuckets) {
    if (bucket.startedAt < cutoff) rateBuckets.delete(key);
  }
}, 10 * 60 * 1000).unref();

function safeTokenEquals(a, b) {
  if (!a || !b) return false;
  const aa = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  return aa.length === bb.length && crypto.timingSafeEqual(aa, bb);
}

function requireDashboardAuth(req, res, next) {
  const expected = (process.env.DASHBOARD_ACCESS_TOKEN || '').trim();
  if (!expected) return res.status(503).json({ error: 'Dashboard authentication is not configured' });
  const auth = req.get('authorization') || '';
  const presented = auth.startsWith('Bearer ') ? auth.slice(7).trim() : (req.get('x-dashboard-token') || '').trim();
  if (!safeTokenEquals(presented, expected)) return res.status(401).json({ error: 'Unauthorized' });
  next();
}

const apiKeys = (process.env.GEMINI_API_KEYS || process.env.GEMINI_API_KEY || '')
  .split(',').map(k => k.trim()).filter(Boolean);

if (!apiKeys.length) {
  console.warn('Gemini is not configured yet. Set GEMINI_API_KEYS.');
}

const MODEL_NAMES = (process.env.GEMINI_MODELS || 'gemini-3.8-flash,gemini-3.5-flash-lite,gemini-3.5-flash')
  .split(',').map(x => x.trim()).filter(Boolean);
const REQUEST_TIMEOUT_MS = Number(process.env.REQUEST_TIMEOUT_MS || 30000);
const PHONE_GEMINI_TIMEOUT_MS = Number(process.env.PHONE_GEMINI_TIMEOUT_MS || 7000);

const CONTENT_FILTER_INSTRUCTION = '';

const EXCLUSIVE_INSTRUCTION = [CONTENT_FILTER_INSTRUCTION, process.env.AI_SYSTEM_INSTRUCTION || '']
  .filter(Boolean).join('\n\n');

const conversationLog = [];
const activeCalls = new Map();
const MAX_CONVERSATION_LOG = 1000;

const SUPABASE_URL = (process.env.SUPABASE_URL || '').replace(/\/$/, '');
const SUPABASE_KEY = (process.env.SUPABASE_KEY || '').trim();
const SUPABASE_ENABLED = !!(SUPABASE_URL && SUPABASE_KEY);

async function supabaseRequest(path, options = {}) {
  if (!SUPABASE_ENABLED) return null;
  const response = await fetch(SUPABASE_URL + path, {
    ...options,
    headers: { apikey: SUPABASE_KEY, Authorization: 'Bearer ' + SUPABASE_KEY,
      'Content-Type': 'application/json', ...(options.headers || {}) }
  });
  if (!response.ok) throw new Error('Supabase HTTP ' + response.status);
  return response;
}
function normalizePhone(value) { const phone = String(value || '').trim(); return phone || 'לא מזוהה'; }
function getCallerNumber(call) {
  return normalizePhone(call?.values?.ApiPhone ?? call?.req?.query?.ApiPhone ??
    call?.req?.body?.ApiPhone ?? call?.query?.ApiPhone);
}
async function loadConversationLog() {
  if (!SUPABASE_ENABLED) return;
  try {
    const r = await supabaseRequest('/rest/v1/conversations?select=id,created_at,phone,call_id,user_text,gemini_text&order=created_at.desc&limit=' + MAX_CONVERSATION_LOG);
    const rows = await r.json();
    conversationLog.splice(0, conversationLog.length, ...rows.reverse().map(row => ({
      id: String(row.id), time: row.created_at, phone: normalizePhone(row.phone),
      callId: String(row.call_id || ''), user: row.user_text || '', gemini: row.gemini_text || ''
    })));
  } catch (e) { console.error('Supabase load error:', e.message); }
}
async function persistConversationEntry(entry) {
  if (!SUPABASE_ENABLED) return;
  try {
    await supabaseRequest('/rest/v1/conversations', {
      method: 'POST', headers: { Prefer: 'return=minimal' },
      body: JSON.stringify({phone: entry.phone, call_id: entry.callId || null,
        user_text: entry.user, gemini_text: entry.gemini})
    });
  } catch (e) { console.error('Supabase save error:', e.message); }
}
async function addConversationEntry({phone, callId, userText, geminiText}) {
  const entry = {id: Date.now() + '-' + conversationLog.length, time: new Date().toISOString(),
    phone: normalizePhone(phone), callId: String(callId || ''), user: userText || '', gemini: geminiText || ''};
  conversationLog.push(entry);
  if (conversationLog.length > MAX_CONVERSATION_LOG)
    conversationLog.splice(0, conversationLog.length - MAX_CONVERSATION_LOG);
  await persistConversationEntry(entry);
}
function sanitizeForYemot(text) {
  if (!text) return '';
  return String(text).replace(/[.&"“”‘’']/g, ' ').replace(/[-–—]/g, ' ')
    .replace(/\s+/g, ' ').trim();
}
function withTimeout(promise, ms, label) {
  let timeoutId;
  const timeoutPromise = new Promise((_, reject) => {
    timeoutId = setTimeout(() => {
      const e = new Error(`Timeout after ${ms}ms: ${label}`); e.status = 408; e.isTimeout = true; reject(e);
    }, ms);
  });
  return Promise.race([promise, timeoutPromise]).finally(() => clearTimeout(timeoutId));
}
function logDetailedError(context, err) { console.error(`[${context}]`, err?.message || err); }

const genAIClients = apiKeys.map(key => new GoogleGenerativeAI(key));
const modelsByName = MODEL_NAMES.map(name => genAIClients.map(ai => ai.getGenerativeModel({model:name})));
const webModelsByName = MODEL_NAMES.map(name => genAIClients.map(ai => ai.getGenerativeModel({model:name, tools:[{googleSearch:{}}]})));

function geminiErrorStatus(err) {
  const status = Number(err?.status || err?.statusCode || err?.response?.status || 0);
  if (status) return status;
  const message = String(err?.message || err || '');
  const match = message.match(/\b(429|500|503|404|408)\b/);
  return match ? Number(match[1]) : 0;
}

async function generateWithRetry(contents, useWebSearch=false, fastPhone=false) {
  if (!modelsByName.length || !modelsByName[0]?.length)
    throw Object.assign(new Error('Gemini is not configured'), {status:400});
  const groups = useWebSearch ? webModelsByName : modelsByName;
  const timeoutMs = fastPhone ? PHONE_GEMINI_TIMEOUT_MS : REQUEST_TIMEOUT_MS;
  const maxAttempts = fastPhone ? 1 : 2;
  let lastError;
  for (let mi=0; mi<groups.length; mi++) {
    for (let ki=0; ki<groups[mi].length; ki++) {
      for (let attempt=1; attempt<=maxAttempts; attempt++) {
        try {
          return await withTimeout(
            groups[mi][ki].generateContent(contents),
            timeoutMs,
            MODEL_NAMES[mi] + ' key #' + (ki+1)
          );
        } catch(e) {
          lastError=e;
          const status=geminiErrorStatus(e);
          if (status === 429) {
            console.warn('[Gemini] quota/rate limit; trying next configured model/key', { model: MODEL_NAMES[mi], key: ki + 1, status, fastPhone });
            // A 429 can be model-specific on the free tier. Keep the phone
            // flow alive by trying the next configured model/key.
            break;
          }
          if (status === 404) {
            console.warn('[Gemini] model unavailable; trying next configured model/key', { model: MODEL_NAMES[mi], key: ki + 1, status });
            break;
          }
          if (status === 408 || status === 503 || (status >= 500 && status < 600)) {
            console.warn('[Gemini] transient error; trying next configured model/key', { model: MODEL_NAMES[mi], key: ki + 1, status, fastPhone });
            break;
          }
          if (status >= 500 && status < 600 && attempt === 1) {
            const delay = 1500;
            console.warn('[Gemini] one 5xx retry', { model: MODEL_NAMES[mi], key: ki + 1, status, delay });
            await new Promise(r=>setTimeout(r, delay));
            continue;
          }
          console.warn('[Gemini] moving to next configured model/key', { model: MODEL_NAMES[mi], key: ki + 1, status });
          break;
        }
      }
    }
  }
  throw lastError;
}

const yemotApi = new YemotApi(process.env.YEMOT_API_USERNAME, process.env.YEMOT_API_PASSWORD);
const router = YemotRouter({
  printLog: true,
  defaults: { removeInvalidChars: true },
  uncaughtErrorHandler: e => logDetailedError('call handler', e)
});

function audioParts(audioBase64) {
  return [{inlineData:{mimeType:process.env.YEMOT_AUDIO_MIME_TYPE || 'audio/wav', data:audioBase64}}];
}

// Resolve simple Israel-time questions in code, avoiding model arithmetic mistakes.
function answerIsraelTimeQuestion(transcript) {
  const q=String(transcript||'').toLowerCase().replace(/[״"'׳]/g,' ').replace(/\s+/g,' ').trim();
  if(!/(מה השעה|איזו שעה|מה תהיה השעה|השעה עכשיו)/.test(q)) return null;
  const now=new Date();
  let minutes=0;
  const amount=(q.match(/\b(\d{1,3})\b/)||[])[1];
  if(/בעוד|עוד|אחרי/.test(q) || (/מה תהיה השעה/.test(q) && !/עכשיו|כרגע/.test(q))) {
    if(/חצי שעה/.test(q)) minutes=30;
    else if(/רבע שעה/.test(q)) minutes=15;
    else if(/שעתיים/.test(q)) minutes=120;
    else if(amount && /דקות|דקה/.test(q)) minutes=Number(amount);
    else if(amount && /שעות|שעה/.test(q)) minutes=Number(amount)*60;
    else if(/שעה/.test(q)) minutes=60;
    else return null;
  }
  const target=new Date(now.getTime()+minutes*60*1000);
  const time=new Intl.DateTimeFormat('he-IL',{timeZone:'Asia/Jerusalem',hour:'2-digit',minute:'2-digit',hourCycle:'h23'}).format(target);
  if(minutes===0) return 'השעה בישראל עכשיו '+time;
  const date=new Intl.DateTimeFormat('he-IL',{timeZone:'Asia/Jerusalem',weekday:'long',day:'numeric',month:'long'}).format(target);
  return 'בעוד '+(minutes===30?'חצי שעה':minutes===15?'רבע שעה':minutes===60?'שעה':minutes===120?'שעתיים':minutes+' דקות')+' תהיה השעה בישראל '+time+' ביום '+date;
}
async function answerNormalQuestion(audioBase64, historyText='') {
  const prompt = `${EXCLUSIVE_INSTRUCTION}

הקשר קודם של השיחה, לפי הסדר: ${historyText || 'אין עדיין הקשר קודם.'}\n\nזו הקלטה של שאלה מהמתקשר. האזן להקלטה, הבן את הדיבור בעצמך, התייחס להקשר הקודם וענה על השאלה.
ענה בשפה שבה המתקשר דיבר. התשובה מיועדת להקראה בטלפון.
אל תצטט תמלול.`;
  const result = await generateWithRetry([...audioParts(audioBase64), {text:prompt}]);
  return result.response.text();
}
async function transcribeForDashboard(audioBase64) {
  const result = await generateWithRetry([...audioParts(audioBase64), {text:
    'תמלל את ההקלטה לצורך תצוגה בלבד. אל תענה על השאלה. החזר רק את התמלול, ללא הסברים.'}]);
  return sanitizeForYemot(result.response.text());
}
function knownContactFallback(transcript, historyText='') {
  const context=(String(transcript||'')+' '+String(historyText||'')).toLowerCase();
  if(/פאגי|פאג״י|pagi/.test(context) && /(מספר|טלפון|יצירת קשר|מוקד|להתקשר|תחפש|חפש)/.test(context))
    return 'מספר שירות הלקוחות של בנק פאגי הוא כוכבית 3360. לתמיכה טכנית באתר ובאפליקציה ניתן להתקשר לאפס שלוש, חמש אחת שלוש, אפס אפס אפס שלוש.';
  return null;
}
async function analyzePublicYouTubeVideo(videoUrl, question) {
  const key = apiKeys[0] || '';
  if (!key) throw Object.assign(new Error('Gemini key unavailable for YouTube video analysis'), {status:503});

  // Use the current Interactions API because it supports passing a public YouTube URL
  // directly as video input. The previous generateContent/fileData approach did not
  // reliably analyze YouTube URLs.
  const model = (process.env.YOUTUBE_GEMINI_MODEL || 'gemini-3.8-flash').trim();
  const prompt = `נתח את סרטון YouTube הציבורי המצורף עצמו, לא רק את הכותרת או התיאור.
השאלה של המתקשר: ${question}
תן מידע מדויק בעברית שמתאים להקראה בטלפון:
1. על מה הסרטון
2. הנקודות המרכזיות שנאמרות בו
3. מי מופיע או מדבר, רק אם ניתן לקבוע זאת מהסרטון
4. אם המתקשר ביקש סיכום, תן סיכום קצר וברור
אל תמציא פרטים. אם חלק מהמידע לא ניתן לקבוע מהסרטון, אמור זאת במפורש.`;

  const response = await withTimeout(fetch('https://generativelanguage.googleapis.com/v1beta/interactions', {
    method:'POST',
    headers:{
      'x-goog-api-key':key,
      'Content-Type':'application/json'
    },
    body:JSON.stringify({
      model,
      store:false,
      input:[
        {type:'text',text:prompt},
        {type:'video',uri:videoUrl}
      ]
    })
  }), REQUEST_TIMEOUT_MS, 'Gemini YouTube video analysis');

  const data=await response.json().catch(()=>({}));
  if(!response.ok) {
    const err=new Error(data?.error?.message || ('Gemini YouTube analysis HTTP '+response.status));
    err.status=response.status;
    throw err;
  }
  const textOutput=String(data?.output_text || '').trim();
  if(!textOutput) {
    const blocks=(data?.steps||[]).flatMap(s=>s?.content||[]).filter(x=>x?.type==='text').map(x=>x.text||'');
    return blocks.join(' ').trim();
  }
  return textOutput;
}

async function searchYouTubeForPhone(transcript) {
  const key=(process.env.YOUTUBE_API_KEY||'').trim();
  if(!key) return null;
  const question=String(transcript||'').trim();
  if(!question || !/(youtube|יוטיוב|סרטון|סרטונים|וידאו)/i.test(question)) return null;
  const wantsNewest=/(הכי חדש|החדש ביותר|הכי חדש|אחרון|אחרונה|עדכני ביותר|חדש ביותר)/i.test(question);
  const query=question.replace(/(תחפש לי באינטרנט|תחפש באינטרנט|חפש באינטרנט|ביוטיוב|ביויוטב|ביוטוב|ביוטיוב|ב youtube|youtube)/gi,' ').replace(/\\s+/g,' ').trim().slice(0,120);
  const url=new URL('https://www.googleapis.com/youtube/v3/search');
  url.searchParams.set('part','snippet');
  url.searchParams.set('q',query||'');
  url.searchParams.set('type','video');
  url.searchParams.set('maxResults','50');
  url.searchParams.set('safeSearch','strict');
  url.searchParams.set('regionCode',process.env.YOUTUBE_REGION_CODE||'IL');
  url.searchParams.set('order',wantsNewest?'date':'relevance');
  url.searchParams.set('key',key);
  const response=await withTimeout(fetch(url),REQUEST_TIMEOUT_MS,'YouTube phone search');
  const data=await response.json();
  if(!response.ok) {
    const err=new Error('YouTube API HTTP '+response.status); err.status=response.status===403?429:response.status; throw err;
  }
  const items=(data.items||[]).filter(x=>x.id?.videoId).slice(0,50);
  if(!items.length) return 'לא מצאתי כרגע סרטונים מתאימים ביוטיוב.';
  const wantsContent=/(תוכן הסרטון|מה אומרים בסרטון|על מה הסרטון|סכם|סיכום|תספר לי מה יש בסרטון|תוכן של הסרטון)/i.test(question);
  if(wantsContent) {
    const selected=items[0];
    const videoUrl='https://www.youtube.com/watch?v='+selected.id.videoId;
    const title=sanitizeForYemot(selected.snippet?.title||'הסרטון שנמצא');
    try {
      const summary=await analyzePublicYouTubeVideo(videoUrl, question);
      if(summary && String(summary).trim())
        return 'מצאתי את הסרטון '+title+'. '+sanitizeForYemot(summary);
    } catch(e) {
      console.warn('[YouTube] video understanding unavailable', {status:geminiErrorStatus(e),message:String(e?.message||'').slice(0,240)});
    }
    return 'מצאתי את הסרטון '+title+' אבל כרגע לא הצלחתי לנתח את תוכן הווידאו עצמו. '+(sanitizeForYemot(selected.snippet?.description||'')||'אין תיאור זמין')+'.';
  }
  const spoken=items.map((x,i)=>{
    const s=x.snippet||{};
    const date=s.publishedAt?new Intl.DateTimeFormat('he-IL',{timeZone:'Asia/Jerusalem',year:'numeric',month:'long',day:'numeric'}).format(new Date(s.publishedAt)):'תאריך לא זמין';
    return 'תוצאה '+(i+1)+': '+sanitizeForYemot(s.title||'ללא כותרת')+'. הערוץ: '+sanitizeForYemot(s.channelTitle||'לא ידוע')+'. פורסם בתאריך '+date+'.';
  }).join(' ');
  const contentNote=/(תוכן הסרטון|מה אומרים בסרטון|על מה הסרטון|סכם|סיכום|תספר לי מה יש בסרטון)/i.test(question)
    ? ' שים לב: החיפוש מצא פרטי סרטון בלבד ולא תמליל מלא, ולכן עדיין אין לי אפשרות לאמת את כל מה שנאמר בו.' : '';
  return 'מצאתי ביוטיוב את התוצאות הבאות. '+spoken+contentNote+' כדי לבחור תוצאה, אמור את מספר התוצאה.';
}
async function answerWithWebSearch(transcript, historyText='') {
  const question=String(transcript||'').trim();
  if(!question) throw Object.assign(new Error('Search requested but transcript is empty'),{status:400});
  const prompt=`${EXCLUSIVE_INSTRUCTION}
הקשר קודם של השיחה:
${historyText || 'אין עדיין הקשר קודם.'}

השאלה המדויקת של המתקשר לחיפוש באינטרנט:
${question}

המתקשר ביקש במפורש חיפוש באינטרנט. השתמש בכלי Google Search המצורף לבקשה וחפש לפי השאלה המדויקת של המתקשר. אל תענה מהזיכרון בלבד.
ענה בשפה שבה המתקשר דיבר, בתשובה קצרה וברורה שמתאימה להקראה בטלפון. כלול מספרי טלפון, כתובות, תאריכים ופרטים שימושיים אם נמצאו במקור אמין, והבחן בין מידע מאומת לבין מידע שלא נמצא.
אם השאלה על סרטון YouTube, חפש לפי הנושא, הכותרת, הערוץ ותאריך הפרסום. אם המתקשר שואל על תוכן הסרטון, השתמש רק בתמליל או בתוכן מלא שנגיש בפועל דרך מקור מותר; אם אין גישה לתוכן עצמו, אמור זאת במפורש והצע סיכום של המידע הזמין בלבד. לעולם אל תטען שצפית בסרטון או קראת תמליל אם לא נגישו.
אם החיפוש נכשל או לא החזיר מידע מספיק, אמור בקצרה שלא הצלחת להשיג מידע אמין כרגע. אל תציג כתובות אינטרנט ארוכות.`;
  const result=await generateWithRetry([{text:prompt}],true,false);
  const answer=result?.response?.text?.();
  if(!answer || !String(answer).trim()) throw Object.assign(new Error('Web search returned an empty answer'),{status:503});
  return String(answer).trim();
}
async function buildOpeningForCaller(phone) {
  const previous = conversationLog.filter(x=>x.phone===normalizePhone(phone)).slice(-8);
  if (!previous.length) return process.env.FIRST_CALL_MESSAGE ||
    'שלום איך אפשר לעזור לך היום אמור בבקשה על מה תרצה לדבר אחרי הצפצוף ולסיום ההקלטה הקש סולמית';
  const history = previous.map(x=>'המתקשר: '+x.user+'\nAI: '+x.gemini).join('\n\n');
  try {
    const r = await generateWithRetry([{text:`${EXCLUSIVE_INSTRUCTION}
אתה בתחילת שיחה חדשה עם מתקשר שכבר דיבר איתך בעבר.
הנה קטעים מהשיחות הקודמות:
${history}
צור פתיח קצר בעברית שמזכיר בקצרה את הנושא האחרון, מאפשר להמשיך משם,
ושואל על מה המתקשר רוצה לדבר עכשיו. אל תמציא פרטים. בלי נקודות ובלי מרכאות.`}]);
    return sanitizeForYemot(r.response.text()) || 'שלום שוב שמח לשמוע ממך על מה תרצה לדבר עכשיו';
  } catch { return 'שלום שוב שמח לשמוע ממך על מה תרצה לדבר עכשיו'; }
}

async function callHandler(call) {
  const callerPhone = getCallerNumber(call);
  const callId = call?.callId || call?.values?.ApiCallId || '';
  const activeKey = String(callId || (Date.now()+'-'+callerPhone));
  activeCalls.set(activeKey,{id:activeKey,phone:callerPhone,callId:String(callId||''),
    startedAt:new Date().toISOString(),status:'ממתין להקלטה'});
  let firstTurn=true;
  let openingPrompt=null;
  const turnHistory=[];
  if (process.env.ENABLE_AI_OPENING !== 'false' && conversationLog.some(x=>x.phone===callerPhone))
    openingPrompt=await buildOpeningForCaller(callerPhone);

  while(true) {
    const prompt=firstTurn?(openingPrompt || process.env.FIRST_CALL_MESSAGE ||
      'שלום איך אפשר לעזור לך היום אמור בבקשה על מה תרצה לדבר אחרי הצפצוף ולסיום ההקלטה הקש סולמית'):
      'אמור שאלה נוספת ולסיום הקש סולמית או הקש כוכבית ליציאה';
    firstTurn=false;
    const recordPath=await call.read([{type:'text',data:prompt}],'record',
      {min_length:1,max_length:60,no_confirm_menu:true});
    if(!recordPath || recordPath==='None') {
      activeCalls.delete(activeKey);
      return call.id_list_message([{type:'text',data:'לא נקלט דבר להתראות'}]);
    }

    const active=activeCalls.get(activeKey);
    if(active) active.status='הקלטה התקבלה — מעבד';

    let audioBuffer;
    try {
      const response=await withTimeout(yemotApi.download_file('ivr2:'+recordPath), REQUEST_TIMEOUT_MS, 'yemotApi.download_file');
      audioBuffer=response.data;
    } catch(e) {
      logDetailedError('recording download',e);
      continue;
    }
    const audioBase64=Buffer.isBuffer(audioBuffer)?audioBuffer.toString('base64'):Buffer.from(audioBuffer).toString('base64');
    console.info('[CALL_FLOW] recording_downloaded', { callId: activeKey, bytes: audioBuffer?.length || 0 });

    const historyText=turnHistory.map((t,i)=>'תור '+(i+1)+' — מתקשר: '+t.user+'\nתשובה: '+t.assistant).join('\n\n');

    let replyText='';
    let userTranscript='';
    try {
      if(active) active.status='שולח Audio ל-Gemini וממתין לתשובה';
      const israelNow = new Intl.DateTimeFormat('he-IL', { timeZone: 'Asia/Jerusalem', dateStyle: 'full', timeStyle: 'short', hourCycle: 'h23' }).format(new Date());
      const firstPass=(await generateWithRetry([...audioParts(audioBase64), {text:`${EXCLUSIVE_INSTRUCTION}\n\nהשעה והתאריך העדכניים בישראל לפי שעון השרת: ${israelNow}. אם נשאלת מה השעה או מה התאריך, השתמש בערך הזה במדויק ואל תנחש או תסתמך על הידע הכללי שלך.\n\nהקשר קודם של השיחה, לפי הסדר:\n${historyText || 'אין עדיין הקשר קודם.'}\n\nהאזן להקלטה והבן את השאלה. החזר אובייקט JSON בלבד עם שני שדות: "transcript" הוא תמלול קצר ומדויק של דברי המתקשר בשפתו; "answer" היא תשובה קצרה וברורה להקראה בטלפון. אם נדרש חיפוש אינטרנט מפורש או מידע עדכני, או אם המתקשר מבקש לאתר סרטון, למצוא סרטון חדש ביוטיוב או לברר פרטי סרטון, קבע answer לערך המדויק SEARCH_REQUEST והוסף transcript כרגיל. אל תבקש מידע שכבר מופיע בהקשר. אל תשתמש בחיפוש לשאלות ידע כללי יציבות או לשעה ולתאריך שמופיעים בהנחיה.`}], false, true)).response.text().trim();
      let parsedTurn=null;
      try { parsedTurn=JSON.parse(firstPass); } catch {
        const match=firstPass.match(/\{[\s\S]*\}/);
        if(match) { try { parsedTurn=JSON.parse(match[0]); } catch {} }
      }
      if(parsedTurn && typeof parsedTurn.answer==='string') {
        replyText=parsedTurn.answer.trim();
        userTranscript=sanitizeForYemot(parsedTurn.transcript||'');
      } else {
        replyText=firstPass;
        userTranscript='';
      }
      console.info('[CALL_FLOW] gemini_answer_ok', { callId: activeKey, chars: replyText.length, transcriptReady: !!userTranscript });
      const deterministicTimeAnswer=answerIsraelTimeQuestion(userTranscript);
      if(deterministicTimeAnswer) replyText=deterministicTimeAnswer;
      else if(replyText.startsWith('SEARCH_REQUEST')) {
        try {
          const youtubeAnswer=await searchYouTubeForPhone(userTranscript);
          replyText=youtubeAnswer || await answerWithWebSearch(userTranscript, historyText);
        } catch(searchError) {
          const fallback=knownContactFallback(userTranscript, historyText);
          if(fallback && [429,503,408].includes(geminiErrorStatus(searchError))) {
            console.warn('[CALL_FLOW] web_search_unavailable_using_known_contact_fallback');
            replyText=fallback;
          } else throw searchError;
        }
      }
    } catch(e) {
      logDetailedError('Gemini processing',e);
      replyText=e.status===429?'מצטערים מנוע התשובות הגיע כרגע למגבלת השימוש נסה שוב בעוד כמה רגעים':
        e.status===503?'מצטערים מנוע התשובות אינו זמין כרגע נסה שוב בעוד רגע':
        e.status===408?'מצטערים לקח יותר מדי זמן לענות נסה שוב':
        'מצטער הייתה תקלה זמנית בעיבוד השאלה אפשר לנסות שוב';
    }

    replyText=sanitizeForYemot(replyText)||'מצטער לא הצלחתי לנסח תשובה נסה שוב';
    console.info('[CALL_FLOW] reply_ready', { callId: activeKey, chars: replyText.length });
    const entry={id:Date.now()+'-'+conversationLog.length,time:new Date().toISOString(),
      phone:normalizePhone(callerPhone),callId:String(callId||''),user:userTranscript || 'לא ניתן היה לתמלל את ההקלטה',gemini:replyText};
    conversationLog.push(entry);
    if(conversationLog.length>MAX_CONVERSATION_LOG)
      conversationLog.splice(0,conversationLog.length-MAX_CONVERSATION_LOG);
    await persistConversationEntry(entry);
    console.info('[CALL_FLOW] conversation_saved', { callId: activeKey, transcriptReady: !!userTranscript });
    if(userTranscript) {
      turnHistory.push({user:userTranscript,assistant:replyText});
      if(turnHistory.length>8) turnHistory.shift();
    }
    console.info('[CALL_FLOW] yemot_handoff_start', { callId: activeKey, chars: replyText.length });
    // Keep the IVR call alive: after playback, continue to the next read in this loop.
    call.id_list_message([{type:'text',data:replyText}], {prependToNextAction:true});
    console.info('[CALL_FLOW] yemot_handoff_queued_next_read', { callId: activeKey });
  }
}


/**
 * Isolated YouTube IVR flow. Results live only in this call's async context.
 * Uses the same raw-recording -> Gemini transcription convention as the main robot.
 */
async function youtubeCallHandler(call) {
  try {
    // Do not use Yemot's paid STT service here. The live account reported
    // "אין מספיק יחידות", so this flow records the caller and uses the
    // already-configured Gemini audio transcription path instead.
    const recordPath = await call.read([
      { type: 'text', data: sanitizeForYemot('ברוכים הבאים לחיפוש ביוטיוב. אמור אחרי הצפצוף את הנושא או שם הערוץ שברצונך לחפש, ולסיום הקש סולמית.') }
    ], 'record', { min_length: 1, max_length: 20, no_confirm_menu: true });

    if (!recordPath || recordPath === 'None') {
      return call.id_list_message([{ type: 'text', data: 'לא נקלט חיפוש. נא לנסות שוב' }]);
    }

    const audioResponse = await withTimeout(
      yemotApi.download_file('ivr2:' + recordPath),
      REQUEST_TIMEOUT_MS,
      'youtube search recording download'
    );
    const audioBuffer = audioResponse.data;
    const audioBase64 = Buffer.isBuffer(audioBuffer)
      ? audioBuffer.toString('base64')
      : Buffer.from(audioBuffer).toString('base64');

    const transcriptionResult = await generateWithRetry([
      ...audioParts(audioBase64),
      { text: 'תמלל רק את דברי המתקשר. החזר רק את התמלול בעברית, בלי הסברים ובלי לענות לשאלה.' }
    ], false, true);

    const transcript = sanitizeForYemot(transcriptionResult.response.text());
    console.info('[YouTube IVR] transcript', { chars: transcript.length, transcript });

    if (!transcript) {
      return call.id_list_message([{ type: 'text', data: 'לא הצלחתי להבין את החיפוש. נא לנסות שוב' }]);
    }

    const videos = (await searchYouTubeVideos(transcript)).slice(0, 9);
    if (!videos.length) {
      return call.id_list_message([{ type: 'text', data: 'לא מצאתי סרטונים מתאימים. נא לנסות שוב במילים אחרות' }]);
    }

    const selectionPrompt = formatYouTubeChoices(videos);
    const keypad = await call.read(
      [{ type: 'text', data: sanitizeForYemot(selectionPrompt) }],
      'tap',
      { min_digits: 1, max_digits: 1, digits_allowed: [1,2,3,4,5,6,7,8,9], sec_wait: 12 }
    );

    const selected = getSelectedYouTubeVideo(videos, keypad);
    if (!selected) {
      return call.id_list_message([{ type: 'text', data: 'הבחירה לא תקינה. נא להקיש מספר בין אחת לתשע' }]);
    }

    const title = sanitizeForYemot(selected.title);
    const playback = await downloadAndUploadYouTubeAudio(selected.videoId);

    console.info('[YouTube IVR] playback uploaded', {
      videoId: selected.videoId,
      remotePath: playback.remotePath
    });

    return call.id_list_message([
      { type: 'text', data: 'בחרת את הסרטון ' + title },
      { type: 'file', data: playback.playbackPath }
    ]);
  } catch (error) {
    logDetailedError('YouTube IVR', error);
    const status = geminiErrorStatus(error);
    const message = status === 429
      ? 'זיהוי הדיבור עמוס כרגע נא לנסות שוב'
      : status === 503
        ? 'שירות יוטיוב אינו זמין כרגע'
        : 'אירעה תקלה בהשמעת הסרטון נא לנסות שוב';
    return call.id_list_message([{ type: 'text', data: message }]);
  }
}

router.get('/yemot', callHandler);
router.get('/yemot-youtube', youtubeCallHandler);
app.use(router);

app.get('/api/conversations', rateLimit(60, 60 * 1000, 'dashboard'), requireDashboardAuth, (req,res)=>res.json({
  conversations:conversationLog,
  activeCalls:Array.from(activeCalls.values()),
  totalMessages:conversationLog.length,
  totalCallers:new Set(conversationLog.map(x=>x.phone)).size,
  serverTime:new Date().toISOString()
}));
app.get('/health',(req,res)=>res.json({ok:true, service:'yemot-gemini-server'}));

app.use('/dashboard', express.static(new URL('./public', import.meta.url).pathname));

app.get('/api/youtube/search', rateLimit(20, 60 * 1000, 'youtube'), requireDashboardAuth, async (req,res)=>{
  const key=(process.env.YOUTUBE_API_KEY||'').trim();
  const q=String(req.query.q||'').trim().slice(0,120);
  if(!key) return res.status(503).json({error:'YouTube search is not configured'});
  if(!q) return res.status(400).json({error:'Missing query'});
  try {
    const url=new URL('https://www.googleapis.com/youtube/v3/search');
    url.searchParams.set('part','snippet');
    url.searchParams.set('q',q);
    url.searchParams.set('type','video');
    url.searchParams.set('maxResults','50');
    url.searchParams.set('safeSearch','strict');
    url.searchParams.set('regionCode',process.env.YOUTUBE_REGION_CODE||'IL');
    url.searchParams.set('key',key);
    const r=await withTimeout(fetch(url),REQUEST_TIMEOUT_MS,'YouTube search');
    const data=await r.json();
    if(!r.ok) return res.status(r.status===403?502:400).json({error:'YouTube search failed'});
    res.setHeader('Cache-Control','no-store');
    return res.json({items:(data.items||[]).map(x=>({
      videoId:x.id?.videoId||'',title:x.snippet?.title||'',description:x.snippet?.description||'',
      channelTitle:x.snippet?.channelTitle||'',publishedAt:x.snippet?.publishedAt||'',
      thumbnail:x.snippet?.thumbnails?.medium?.url||x.snippet?.thumbnails?.default?.url||''
    })).filter(x=>x.videoId)});
  } catch(e) {
    logDetailedError('YouTube search',e);
    return res.status(502).json({error:'YouTube search unavailable'});
  }
});
app.get('/',(req,res)=>res.type('html').send('<!doctype html><html lang="he" dir="rtl"><head><meta charset="utf-8"><title>AI Phone Line</title></head><body><h1>AI Phone Line Dashboard</h1><p>המערכת מחוברת וממתינה לשיחות</p></body></html>'));

async function configureYemotStructure() {
  const apiUser=(process.env.YEMOT_API_USERNAME||'').trim();
  const apiPassword=(process.env.YEMOT_API_PASSWORD||'').trim();
  if(!apiUser || !apiPassword) {
    console.log('Yemot system number or management password missing; skipping automatic setup');
    return;
  }

  const token=apiUser+':'+apiPassword;
  const base='https://www.call2all.co.il/ym/api';

  async function updateExtension(path,params) {
    const qs=new URLSearchParams({token,path,...params});
    const url=base + '/UpdateExtension?' + qs.toString();
    const r=await fetch(url);
    const responseText=await r.text();
    let data;
    try { data=JSON.parse(responseText); } catch { data={raw:responseText}; }

    if(!r.ok) throw new Error('UpdateExtension HTTP ' + r.status + ' path=' + path);
    if(data.responseStatus && data.responseStatus!=='OK') {
      const detail=data.message || data.error || data.responseStatus;
      throw new Error('UpdateExtension failed path=' + path + ': ' + String(detail).slice(0,180));
    }
    console.log('[Yemot automatic setup] UpdateExtension OK path=' + path);
    return data;
  }

  const publicUrl=(process.env.PUBLIC_BASE_URL||'').replace(/\/$/,'');
  if(!publicUrl) {
    console.log('PUBLIC_BASE_URL missing; skipping automatic IVR URL setup');
    return;
  }

  let parsedBase;
  try { parsedBase = new URL(publicUrl); }
  catch { throw new Error('PUBLIC_BASE_URL is invalid'); }
  if(parsedBase.protocol !== 'https:') throw new Error('PUBLIC_BASE_URL must use HTTPS');

  await updateExtension('ivr2:/1',{type:'api',api_link:publicUrl + '/yemot'});
  // Extension 2 is the isolated YouTube robot; preserve voice selection under extension 3.
  await updateExtension('ivr2:/2',{type:'api',api_link:publicUrl + '/yemot-youtube'});

  const voiceMap=(process.env.YEMOT_VOICE_OPTIONS||'1:Elik_2100,2:Jacob,3:ymMale').split(',');
  for(const item of voiceMap) {
    const [extension,voice]=item.split(':');
    if(!extension||!voice) continue;
    await updateExtension('ivr2:/' + '3/' + extension,{
      type:'add_id_to_list',
      add_id_to_list_location_list:'/ivr',
      add_id_to_list_key:'voice',
      add_id_to_list_value:voice,
      add_id_to_list_value_change:'yes',
      add_id_to_list_end_goto:'/1',
      add_id_to_list_error_end_goto:'/2'
    });
  }
}

process.on('unhandledRejection',(reason)=>{if(!(reason instanceof ExitError)) logDetailedError('Unhandled Rejection',reason)});
process.on('uncaughtException',(err)=>{if(!(err instanceof ExitError)) logDetailedError('Uncaught Exception',err)});
const port=process.env.PORT||3000;
app.listen(port,async()=>{
  console.log('server running on port '+port);
  await loadConversationLog();
  try { await configureYemotStructure(); }
  catch (e) { logDetailedError('Yemot automatic setup', e); }
});
