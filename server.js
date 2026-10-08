import express from 'express';
import crypto from 'node:crypto';
import { YemotRouter, ExitError } from 'yemot-router2';
import { GoogleGenerativeAI } from '@google/generative-ai';
import YemotApi from 'yemot-api';
import { searchYouTubeVideos } from './youtube-ivr.js';
import { getYouTubeTranscript } from './youtube-transcript.js';
import { downloadAuthorizedAudioToYemot } from './youtube-authorized-playback.js';

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

console.log('[Gemini] configured key count:', apiKeys.length);

if (!apiKeys.length) {
  console.warn('Gemini is not configured yet. Set GEMINI_API_KEYS.');
}

const configuredModelNames = (process.env.GEMINI_MODELS || 'gemini-3.8-flash,gemini-3.5-flash-lite,gemini-3.5-flash')
  .split(',').map(x => x.trim()).filter(Boolean);
// Keep the user's configured order, but always have a current high-volume audio-capable
// fallback available. Gemini 3.1 Flash-Lite is designed for high-volume, low-latency
// multimodal work and supports audio input.
const MODEL_NAMES = [...new Set([
  ...configuredModelNames,
  'gemini-3.1-flash-lite'
])];
const REQUEST_TIMEOUT_MS = Number(process.env.REQUEST_TIMEOUT_MS || 30000);
const PHONE_GEMINI_TIMEOUT_MS = Number(process.env.PHONE_GEMINI_TIMEOUT_MS || 12000);
// Long answers are intentionally given the normal generation budget instead of the
// low-latency phone budget. This prevents multi-minute answers from being cut off
// by the short-turn timeout while keeping ordinary turns fast.
const LONG_ANSWER_TIMEOUT_MS = Number(process.env.LONG_ANSWER_TIMEOUT_MS || 90000);
const LONG_ANSWER_MAX_CHARS = Number(process.env.LONG_ANSWER_MAX_CHARS || 12000);
const DIRECT_WEB_QUERY_TIMEOUT_MS = Number(process.env.DIRECT_WEB_QUERY_TIMEOUT_MS || 4500);
// Deepgram is the primary Hebrew phone ASR. Keep its timeout separate from Gemini so
// a slow Deepgram request does not inherit Gemini's tighter phone-answer timeout.
// 18s is only a safety ceiling; successful requests should return much sooner.
const PHONE_DEEPGRAM_TIMEOUT_MS = Number(process.env.PHONE_DEEPGRAM_TIMEOUT_MS || 18000);
const MEDIA_MAX_IMAGE_BYTES = Number(process.env.MEDIA_MAX_IMAGE_BYTES || 12000000);
const MEDIA_MAX_VIDEO_BYTES = Number(process.env.MEDIA_MAX_VIDEO_BYTES || 95000000);
const MEDIA_ANALYSIS_TIMEOUT_MS = Number(process.env.MEDIA_ANALYSIS_TIMEOUT_MS || 45000);
const MEDIA_SEARCH_TIMEOUT_MS = Number(process.env.MEDIA_SEARCH_TIMEOUT_MS || 18000);
const MEDIA_MAX_CANDIDATES = Number(process.env.MEDIA_MAX_CANDIDATES || 6);

// Avoid repeatedly hammering Gemini after the API has explicitly reported quota exhaustion.
// This is especially important on phone calls, where a second fallback request can turn one
// quota event into several consecutive failures.
const GEMINI_QUOTA_COOLDOWN_MS = Number(process.env.GEMINI_QUOTA_COOLDOWN_MS || 15000);
// Cool down a specific model/key after a 429 so every new phone turn does not
// repeatedly hit the same exhausted bucket before moving to a healthy fallback.
const geminiQuotaCooldowns = new Map();
let lastGeminiQuotaError = null;

const CONTENT_FILTER_INSTRUCTION = '';

const DIALOGUE_STYLE_INSTRUCTION = [
  'דבר בעברית טבעית, חמה, חכמה ואישית. השיחה צריכה להרגיש כמו שיחה עם אדם חד, רגוע, קשוב ומעניין, לא כמו מוקד אוטומטי.',
  'התאם את אורך התשובה לקצב השיחה. בדרך כלל 1 עד 4 משפטים קצרים, אבל כשצריך הסבר או ייעוץ אפשר להרחיב בהדרגה ולא להציף.',
  'כשמבקשים עצה, אל תיתן סיסמאות. הבן את המצב, הפרד בין עובדות להנחות, שקול כמה אפשרויות, הצג יתרונות וחסרונות, ואז תן כיוון מעשי והגיוני. אם יש פרט חסר שמשנה את העצה, שאל שאלה אחת ממוקדת.',
  'היה אנושי בשיחה: אפשר להראות הבנה, הומור עדין כשמתאים, סקרנות וחשיבה משותפת. אל תהיה מתיילד, מתחנף או מלאכותי.',
  'כשיש זיכרון אמיתי משיחות קודמות, השתמש בו כדי להמשיך את השיחה ולא רק להזכיר אותו. אם אין זיכרון אמיתי אל תמציא היכרות או פרטים.',
  'אם נושא חוזר משיחה קודמת, אפשר לומר בקצרה מה כבר סיכמנו ולהמשיך מהנקודה שבה נעצרנו. אל תחזור על כל ההיסטוריה.',
  'לשאלות עובדתיות שאין לך ודאות לגביהן, אל תמציא. אם יש צורך במידע עדכני, חפש אותו באינטרנט.',
  'אל תחזור על הוראות שימוש שהמתקשר כבר מכיר, ואל תגיד לו להקיש סולמית אלא אם זה באמת נדרש כדי להמשיך.',
  'אל תשאל בסוף כל תשובה אם זה עזר ואל תוסיף משפטי נימוס קבועים באופן אוטומטי.',
  'אם המתקשר מתלבט, עזור לו לחשוב בקול רם: נסח את הבעיה, הצג שיקולים חשובים, והצע צעד הבא ברור.',
  'אם המתקשר מבקש מידע עדכני, חדשות או YouTube, השתמש בגישה האינטרנטית של המערכת ונסה להביא את המידע בעצמך.',
  'בתשובה קולית העדף עברית טבעית, משפטים שקל לשמוע בטלפון, ניסוח זורם והגייה פשוטה. הימנע מרשימות ארוכות וממשפטים מסורבלים.'
].join('\n');
const EXCLUSIVE_INSTRUCTION = [CONTENT_FILTER_INSTRUCTION, DIALOGUE_STYLE_INSTRUCTION, process.env.AI_SYSTEM_INSTRUCTION || '']
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
function normalizePhone(value) {
  const raw=String(value || '').trim();
  if(!raw) return 'לא מזוהה';
  const digits=raw.replace(/[^0-9]/g,'');
  if(!digits) return raw;
  if(digits.startsWith('972') && digits.length >= 11) return '0' + digits.slice(3);
  if(digits.startsWith('00972') && digits.length >= 13) return '0' + digits.slice(5);
  return digits;
}
function getCallerNumber(call) {
  const candidates=[call?.values?.ApiPhone,call?.values?.apiPhone,
    call?.req?.query?.ApiPhone,call?.req?.body?.ApiPhone];
  for(const candidate of candidates) {
    if(candidate!==undefined && candidate!==null && String(candidate).trim()) return normalizePhone(candidate);
  }
  const containers=[call?.values,call?.req?.query,call?.req?.body];
  for(const obj of containers) {
    if(!obj || typeof obj!=='object') continue;
    for(const [key,value] of Object.entries(obj)) {
      if(/^(api)?phone$|caller.*(phone|number)|(phone|number).*caller/i.test(String(key)) && value!==undefined && value!==null && String(value).trim()) return normalizePhone(value);
    }
  }
  return 'לא מזוהה';
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
  // Yemot response text cannot contain the pipe character; YouTube titles and
  // search results commonly contain it, so normalize it before every handoff.
  return String(text)
    .replace(/[|]/g, ' ')
    .replace(/[.&"“”‘’']/g, ' ')
    .replace(/[-–—]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
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
function logDetailedError(context, err) {
  const clean = String(err?.message || err || 'Unknown error')
    .replace(/[\\u001b\\u009b][[\\]()#;?]*(?:(?:(?:[a-zA-Z\\d]*(?:;[-a-zA-Z\\d/#&.:=?%@~_]+)*)?\\u0007)|(?:(?:\\d{1,4}(?:;\\d{0,4})*)?[\\dA-PR-TZcf-nq-uy=><~]))/g, '');
  console.error(`[${context}]`, clean);
}

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

async function generateWithRetry(contents, useWebSearch=false, fastPhone=false, timeoutOverrideMs=null) {
  if (!modelsByName.length || !modelsByName[0]?.length)
    throw Object.assign(new Error('Gemini is not configured'), {status:400});
  const groups = useWebSearch ? webModelsByName : modelsByName;
  const timeoutMs = Number(timeoutOverrideMs || (fastPhone ? PHONE_GEMINI_TIMEOUT_MS : REQUEST_TIMEOUT_MS));
  const maxAttempts = fastPhone ? 1 : 2;
  let lastError;

  for (let mi=0; mi<groups.length; mi++) {
    for (let ki=0; ki<groups[mi].length; ki++) {
      const cooldownKey = MODEL_NAMES[mi] + ':key:' + (ki + 1);
      const cooldownUntil = geminiQuotaCooldowns.get(cooldownKey) || 0;
      if (cooldownUntil > Date.now()) {
        console.warn('[Gemini] skipping model/key during quota cooldown', {
          model: MODEL_NAMES[mi], key: ki + 1,
          remainingMs: cooldownUntil - Date.now(), fastPhone
        });
        continue;
      }

      for (let attempt=1; attempt<=maxAttempts; attempt++) {
        try {
          // Always pass the legacy SDK an explicit GenerateContentRequest object.
          // Passing a bare Content[] is ambiguous in @google/generative-ai and has
          // caused malformed REST payloads such as "Unknown name inlineData at contents[0]".
          const request = {
            contents,
            ...(fastPhone ? {
              generationConfig: { thinkingConfig: { thinkingLevel: 'low' } }
            } : {})
          };
          return await withTimeout(
            groups[mi][ki].generateContent(request),
            timeoutMs,
            MODEL_NAMES[mi] + ' key #' + (ki+1)
          );
        } catch(e) {
          lastError=e;
          const status=geminiErrorStatus(e);
          if (status === 429) {
            lastGeminiQuotaError = e;
            geminiQuotaCooldowns.set(cooldownKey, Date.now() + GEMINI_QUOTA_COOLDOWN_MS);
            console.warn('[Gemini] quota/rate limit; cooling down this model/key and trying next', {
              model: MODEL_NAMES[mi], key: ki + 1, status, fastPhone,
              cooldownMs: GEMINI_QUOTA_COOLDOWN_MS
            });
            break;
          }
          if (status === 404) {
            console.warn('[Gemini] model unavailable; trying next configured model/key', {
              model: MODEL_NAMES[mi], key: ki + 1, status
            });
            break;
          }
          if (status === 408 || status === 503 || (status >= 500 && status < 600)) {
            console.warn('[Gemini] transient error; trying next configured model/key', {
              model: MODEL_NAMES[mi], key: ki + 1, status, fastPhone
            });
            break;
          }
          console.warn('[Gemini] moving to next configured model/key', {
            model: MODEL_NAMES[mi], key: ki + 1, status
          });
          break;
        }
      }
    }
  }
  // All API keys in the same Google Cloud project share the project's
  // quota. If every configured model/key was rejected with 429, do not
  // manufacture a different answer or hammer the same exhausted bucket.
  throw lastError;
}


const BRANCH1_BACKUP_GEMINI_API_KEY = (process.env.GEMINI_BACKUP_API_KEY || '').trim();
const branch1BackupGeminiClient = BRANCH1_BACKUP_GEMINI_API_KEY
  ? new GoogleGenerativeAI(BRANCH1_BACKUP_GEMINI_API_KEY)
  : null;
const branch1BackupModelNames = [...new Set([
  ...MODEL_NAMES
])];
const branch1BackupModels = branch1BackupGeminiClient
  ? branch1BackupModelNames.map(model => branch1BackupGeminiClient.getGenerativeModel({model}))
  : [];
const branch1BackupWebModels = branch1BackupGeminiClient
  ? branch1BackupModelNames.map(model => branch1BackupGeminiClient.getGenerativeModel({model, tools:[{googleSearch:{}}]}))
  : [];

async function generateBranch1WithFallback(contents, useWebSearch=false, fastPhone=false, timeoutOverrideMs=null) {
  try {
    return await generateWithRetry(contents, useWebSearch, fastPhone, timeoutOverrideMs);
  } catch (primaryError) {
    const primaryStatus=geminiErrorStatus(primaryError);
    const shouldFallback=[429,408,500,502,503,504].includes(primaryStatus);
    if(!shouldFallback || !branch1BackupGeminiClient || !branch1BackupModels.length) {
      throw primaryError;
    }

    const models=useWebSearch ? branch1BackupWebModels : branch1BackupModels;
    const timeoutMs=Number(timeoutOverrideMs || (fastPhone ? PHONE_GEMINI_TIMEOUT_MS : REQUEST_TIMEOUT_MS));
    let lastError=primaryError;

    console.warn('[BRANCH1 FALLBACK] primary Gemini unavailable; trying separate backup Project', {
      status:primaryStatus, useWebSearch, fastPhone
    });

    for(let i=0;i<models.length;i++) {
      try {
        const request={
          contents,
          ...(fastPhone ? {
            generationConfig:{thinkingConfig:{thinkingLevel:'low'}}
          } : {})
        };
        const result=await withTimeout(
          models[i].generateContent(request),
          timeoutMs,
          'branch1 backup Gemini '+branch1BackupModelNames[i]
        );
        console.info('[BRANCH1 FALLBACK] backup Project succeeded', {
          model:branch1BackupModelNames[i], useWebSearch, fastPhone
        });
        return result;
      } catch(e) {
        lastError=e;
        console.warn('[BRANCH1 FALLBACK] backup model failed', {
          model:branch1BackupModelNames[i],
          status:geminiErrorStatus(e),
          useWebSearch, fastPhone
        });
      }
    }
    throw lastError;
  }
}

const yemotApi = new YemotApi(process.env.YEMOT_API_USERNAME, process.env.YEMOT_API_PASSWORD);
const router = YemotRouter({
  printLog: true,
  // Keep the same Call state alive for a long time so a caller can have
  // many back-and-forth turns without Yemot-router2 expiring the call.
  timeout: 15 * 60 * 1000,
  defaults: {
    removeInvalidChars: true,
    read: { timeout: 10 * 60 * 1000 }
  },
  uncaughtErrorHandler: e => logDetailedError('call handler', e)
});

function audioContents(audioBase64, text) {
  const parts = [{inlineData:{mimeType:process.env.YEMOT_AUDIO_MIME_TYPE || 'audio/wav', data:audioBase64}}];
  if (text) parts.push({text});
  return [{role:'user', parts}];
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
function answerDailyDateQuestion(transcript) {
  const q=String(transcript||'').toLowerCase().replace(/[״"'׳]/g,' ').replace(/\s+/g,' ').trim();
  if(!/(מה התאריך|איזה תאריך|התאריך היום|איזה יום היום|מה היום|תאריך עברי|היום העברי|התאריך העברי)/.test(q)) return null;
  const now=new Date();
  const gregorian=new Intl.DateTimeFormat('he-IL',{timeZone:'Asia/Jerusalem',dateStyle:'full'}).format(now);
  const hebrew=new Intl.DateTimeFormat('he-IL-u-ca-hebrew',{timeZone:'Asia/Jerusalem',dateStyle:'long'}).format(now);
  return 'היום בישראל '+gregorian+', והתאריך העברי הוא '+hebrew+'.';
}

async function transcribeWithDeepgram(audioBuffer, overrideKey='') {
  const key=(overrideKey || process.env.DEEPGRAM_API_KEY || '').trim();
  if(!key) return null;

  const bytes=Buffer.isBuffer(audioBuffer)?audioBuffer:Buffer.from(audioBuffer);
  const mimeType=(process.env.YEMOT_AUDIO_MIME_TYPE||detectAudioMime(bytes)||'audio/wav').trim();
  const vocabulary=(process.env.DEEPGRAM_KEYTERMS ||
    'יוטיוב,YouTube,גוגל,Google,אילן גוזל,רנולד,ימות,רנולד שוורצנגר')
    .split(',').map(x=>x.trim()).filter(Boolean).slice(0,100);

  const url=new URL('https://api.deepgram.com/v1/listen');
  url.searchParams.set('model','nova-3');
  url.searchParams.set('language','he');
  url.searchParams.set('smart_format','true');
  url.searchParams.set('punctuate','true');
  url.searchParams.set('filler_words','false');
  for(const term of vocabulary) url.searchParams.append('keyterm',term);

  const response=await withTimeout(fetch(url,{
    method:'POST',
    headers:{
      'Authorization':'Token '+key,
      'Content-Type':mimeType
    },
    body:bytes
  }),PHONE_DEEPGRAM_TIMEOUT_MS,'Deepgram Nova-3 Hebrew transcription');

  const data=await response.json().catch(()=>({}));
  if(!response.ok) {
    throw Object.assign(
      new Error(data?.err_msg || data?.message || 'Deepgram transcription HTTP '+response.status),
      {status:response.status}
    );
  }

  const transcript=String(
    data?.results?.channels?.[0]?.alternatives?.[0]?.transcript || ''
  ).trim();

  if(!transcript) throw Object.assign(new Error('Deepgram returned empty transcription'),{status:503});

  const cleaned=sanitizeForYemot(transcript);
  if(cleaned) {
    console.info('[TRANSCRIBE] deepgram_nova3_he_ok',{
      mimeType,chars:cleaned.length,text:cleaned
    });
    return cleaned;
  }
  throw Object.assign(new Error('Deepgram transcription became empty after cleanup'),{status:503});
}

async function transcribePhoneAudio(audioBuffer) {
  // Primary path for Israeli Hebrew phone speech: Deepgram Nova-3 when configured.
  // It is purpose-built for speech-to-text, supports Hebrew in production, and
  // supports keyterm prompting for names and YouTube/channel terminology.
  if((process.env.DEEPGRAM_API_KEY||'').trim()) {
    try {
      const deepgramText=await transcribeWithDeepgram(audioBuffer);
      if(deepgramText) return deepgramText;
    } catch(err) {
      console.warn('[TRANSCRIBE] Deepgram primary failed',{
        status:geminiErrorStatus(err),
        message:String(err?.message||err).slice(0,500)
      });
    }
  }

  // Existing Gemini transcription chain remains intact as the fallback, so
  // adding the better Hebrew ASR cannot break the current working system.
  // Primary path: Gemini 3.5 Transcribe through the documented GenerateContent
  // endpoint. This is intentionally kept separate from the answer models so a
  // transcription problem cannot damage the rest of the call flow.
  const configuredMime=(process.env.YEMOT_AUDIO_MIME_TYPE || '').trim();
  const bytes=Buffer.isBuffer(audioBuffer)?audioBuffer:Buffer.from(audioBuffer);
  const mimeType=configuredMime || detectAudioMime(bytes);
  const vocabulary=(process.env.GEMINI_TRANSCRIBE_VOCABULARY ||
    'Gemini,YouTube,יוטיוב,גוגל,Google,YouTube,API,Render,Supabase')
    .split(',').map(x=>x.trim()).filter(Boolean).slice(0,100);

  let lastError;

  for (let ki=0; ki<apiKeys.length; ki++) {
    const key=apiKeys[ki];
    let uploadedFileUri='';
    try {
      const startUpload=await withTimeout(fetch(
        'https://generativelanguage.googleapis.com/upload/v1beta/files',
        {
          method:'POST',
          headers:{
            'x-goog-api-key':key,
            'X-Goog-Upload-Protocol':'resumable',
            'X-Goog-Upload-Command':'start',
            'X-Goog-Upload-Header-Content-Length':String(bytes.length),
            'X-Goog-Upload-Header-Content-Type':mimeType,
            'Content-Type':'application/json'
          },
          body:JSON.stringify({file:{display_name:'yemot-phone-audio'}})
        }
      ),REQUEST_TIMEOUT_MS,'Gemini transcription upload start');

      if(!startUpload.ok) {
        throw Object.assign(new Error('Gemini transcription upload start HTTP '+startUpload.status),{status:startUpload.status});
      }
      const uploadUrl=startUpload.headers.get('x-goog-upload-url');
      if(!uploadUrl) throw Object.assign(new Error('Gemini transcription upload URL missing'),{status:503});

      const upload=await withTimeout(fetch(uploadUrl,{
        method:'POST',
        headers:{
          'Content-Length':String(bytes.length),
          'X-Goog-Upload-Offset':'0',
          'X-Goog-Upload-Command':'upload, finalize',
          'Content-Type':mimeType
        },
        body:bytes
      }),REQUEST_TIMEOUT_MS,'Gemini transcription upload');

      const fileInfo=await upload.json().catch(()=>({}));
      if(!upload.ok || !fileInfo.file?.uri) {
        throw Object.assign(
          new Error(fileInfo.error?.message || 'Gemini transcription file upload failed'),
          {status:upload.status || 503}
        );
      }

      uploadedFileUri=fileInfo.file.uri;
      const endpoint='https://generativelanguage.googleapis.com/v1beta/models/gemini-3.5-transcribe:generateContent';

      // First try the dedicated transcription model directly. Google documents
      // this route specifically for file-based transcription and it avoids the
      // Interactions response-shape/API compatibility issue we were seeing.
      const directResponse=await withTimeout(fetch(endpoint,{
        method:'POST',
        headers:{
          'x-goog-api-key':key,
          'Content-Type':'application/json'
        },
        body:JSON.stringify({
          contents:[{
            role:'user',
            parts:[
              {fileData:{mimeType,fileUri:fileInfo.file.uri}},
              {text:[
                'תמלל בדיוק את כל דברי המתקשר בעברית.',
                'אל תשנה שמות, מספרים, שמות ערוצים, שמות סרטונים או מילים באנגלית.',
                'אל תשלים מילים שלא נשמעו.',
                'החזר רק את התמלול, בלי הסבר ובלי לענות לשאלה.',
                'מונחים ושמות שעשויים להופיע: '+vocabulary.join(', ')+'.'
              ].join(' ')}
            ]
          }]
        })
      }),PHONE_GEMINI_TIMEOUT_MS,'Gemini 3.5 Transcribe direct');

      const directData=await directResponse.json().catch(()=>({}));
      if(!directResponse.ok) {
        throw Object.assign(
          new Error(directData.error?.message || 'Gemini 3.5 Transcribe direct HTTP '+directResponse.status),
          {status:directResponse.status}
        );
      }

      const directText=String(
        directData.candidates?.[0]?.content?.parts?.map(p=>p?.text||'').join(' ') ||
        directData.output_text ||
        ''
      ).trim();

      if(directText) {
        const cleaned=sanitizeForYemot(directText);
        if(cleaned) {
          console.info('[TRANSCRIBE] gemini_35_direct_ok',{
            key:ki+1,mimeType,chars:cleaned.length,text:cleaned
          });
          return cleaned;
        }
      }

      throw Object.assign(new Error('Gemini 3.5 Transcribe direct returned empty text'),{status:503});
    } catch(err) {
      lastError=err;
      console.warn('[TRANSCRIBE] dedicated direct attempt failed',{
        key:ki+1,status:geminiErrorStatus(err),
        message:String(err?.message||err).slice(0,500)
      });

      // Secondary path: Interactions API, retained as a compatibility fallback.
      try {
        const endpoint='https://generativelanguage.googleapis.com/v1beta/interactions';
        const response=await withTimeout(fetch(endpoint,{
          method:'POST',
          headers:{
            'x-goog-api-key':key,
            'Content-Type':'application/json'
          },
          body:JSON.stringify({
            model:'gemini-3.5-transcribe',
            input:[{type:'audio',uri:uploadedFileUri,mime_type:mimeType}],
            generation_config:{
              transcription_config:{
                language_codes:['he-IL'],
                mode:{type:'verbatim'},
                custom_vocabulary:vocabulary
              }
            }
          })
        }),PHONE_GEMINI_TIMEOUT_MS,'Gemini 3.5 Transcribe Interactions');

        const data=await response.json().catch(()=>({}));
        if(!response.ok) {
          throw Object.assign(
            new Error(data.error?.message || 'Gemini Transcribe Interactions HTTP '+response.status),
            {status:response.status}
          );
        }

        const text=String(
          data.output_text ||
          data.outputText ||
          (Array.isArray(data.output)
            ? data.output.map(item => item?.text || item?.content?.map?.(p => p?.text || '').join(' ') || '').join(' ')
            : '')
        ).trim();

        if(text) {
          const cleaned=sanitizeForYemot(text);
          if(cleaned) {
            console.info('[TRANSCRIBE] gemini_35_interactions_ok',{
              key:ki+1,mimeType,chars:cleaned.length,text:cleaned
            });
            return cleaned;
          }
        }
        throw Object.assign(new Error('Gemini Transcribe Interactions returned empty text'),{status:503});
      } catch(interactionsError) {
        lastError=interactionsError;
        console.warn('[TRANSCRIBE] interactions fallback failed',{
          key:ki+1,status:geminiErrorStatus(interactionsError),
          message:String(interactionsError?.message||interactionsError).slice(0,500)
        });
      }

      // Final safety net: preserve the old working audio path so this change
      // cannot turn a previously usable call into a dead call.
      try {
        const legacy=await generateWithRetry(
          audioContents(
            bytes.toString('base64'),
            'תמלל בדיוק את דברי המתקשר. אל תענה לשאלה ואל תשנה את המשמעות. החזר רק את התמלול.'
          ),
          false,
          true
        );
        const legacyText=String(legacy?.response?.text?.() || '').trim();
        if(legacyText) {
          const cleaned=sanitizeForYemot(legacyText);
          console.info('[TRANSCRIBE] legacy_audio_fallback_ok',{
            key:ki+1,chars:cleaned.length,text:cleaned
          });
          if(cleaned) return cleaned;
        }
      } catch(fallbackError) {
        lastError=fallbackError;
        console.warn('[TRANSCRIBE] legacy fallback failed',{
          key:ki+1,status:geminiErrorStatus(fallbackError),
          message:String(fallbackError?.message||fallbackError).slice(0,500)
        });
      }
    }
  }

  throw lastError || Object.assign(new Error('Phone transcription unavailable'),{status:503});
}

async function transcribeBackupPhoneAudio(audioBuffer) {
  const key=(process.env.DEEPGRAM_BACKUP_API_KEY || process.env.YEMOT_BACKUP_DEEPGRAM_API_KEY || '').trim();
  if(key) {
    try {
      const text=await transcribeWithDeepgram(audioBuffer,key);
      if(text) return text;
    } catch(err) {
      console.warn('[BACKUP TRANSCRIBE] Deepgram failed',{
        status:geminiErrorStatus(err),
        message:String(err?.message||err).slice(0,500)
      });
    }
  }
  const bytes=Buffer.isBuffer(audioBuffer)?audioBuffer:Buffer.from(audioBuffer);
  try {
    const result=await generateBackupWithRetry(
      audioContents(bytes.toString('base64'),
        'תמלל בדיוק את דברי המתקשר בעברית. אל תשנה שמות, מספרים או מילים באנגלית. אל תשלים מילים שלא נשמעו. החזר רק את התמלול.'),
      false
    );
    const text=String(result?.response?.text?.()||'').trim();
    const cleaned=sanitizeForYemot(text);
    if(cleaned) return cleaned;
  } catch(err) {
    console.warn('[BACKUP TRANSCRIBE] Gemini backup failed',{
      status:geminiErrorStatus(err),
      message:String(err?.message||err).slice(0,500)
    });
  }
  throw Object.assign(new Error('Backup phone transcription unavailable'),{status:503});
}

function detectAudioMime(bytes) {
  if(!bytes || bytes.length < 4) return 'audio/wav';
  if(bytes.subarray(0,4).toString('ascii') === 'RIFF') return 'audio/wav';
  if(bytes.subarray(0,3).toString('ascii') === 'ID3') return 'audio/mp3';
  if(bytes.subarray(0,4).toString('ascii') === 'OggS') return 'audio/ogg';
  if(bytes.subarray(0,4).toString('ascii') === 'fLaC') return 'audio/flac';
  if(bytes[0]===0xFF && (bytes[1]===0xFB || bytes[1]===0xF3 || bytes[1]===0xF2)) return 'audio/mpeg';
  // Yemot normally supplies WAV. Keep the explicit environment variable as
  // an override for deployments using another recording format.
  return 'audio/wav';
}

async function answerNormalQuestion(transcript, historyText='') {
  const prompt=EXCLUSIVE_INSTRUCTION+'\n\nהקשר קודם של השיחה, לפי הסדר: '+(historyText || 'אין עדיין הקשר קודם.')+'\n\nהשאלה המתומללת של המתקשר:\n'+transcript+'\n\nענה על השאלה. ענה בשפה שבה המתקשר דיבר. התשובה מיועדת להקראה בטלפון.';
  // Coverage rules for the main branch: live business/service details, events, transit, daily information, and deep current-affairs research.\n  prompt += '\\n\\nכללי כיסוי: לעסק או מוסד חפש כתובת, שעות פתיחה, טלפון ואתר רשמי. לאירועים ופעילויות חפש לפי עיר/אזור, תאריך, שעה, מקום, מחיר וכרטיסים ממקור רשמי. לתחבורה ציבורית חפש מסלול, קווים, תחנות, החלפות וזמני יציאה/הגעה; זמן אמת יוצג ככזה רק אם מקור עדכני מאמת אותו. לטיולים בנה מסלול מעשי לפי מוצא, יעד, זמן ותחבורה. למידע יומי ספק תאריך, יום בשבוע, תאריך עברי וזמני יום לפי מקורות מתאימים. לחדשות, טכנולוגיה, מדע, טבע, בריאות וספורט חפש לעומק והשווה מקורות עדכניים. אל תציג הערכה או מידע ישן כאילו הוא מידע חי.';
  const result=await generateWithRetry([{role:'user',parts:[{text:prompt}]}]);
  return result.response.text();
}
async function transcribeForDashboard(audioBase64) { return transcribePhoneAudio(Buffer.from(audioBase64,'base64')); }
function knownContactFallback(transcript, historyText='') {
  const context=(String(transcript||'')+' '+String(historyText||'')).toLowerCase();
  if(/פאגי|פאג״י|pagi/.test(context) && /(מספר|טלפון|יצירת קשר|מוקד|להתקשר|תחפש|חפש)/.test(context))
    return 'מספר שירות הלקוחות של בנק פאגי הוא כוכבית 3360. לתמיכה טכנית באתר ובאפליקציה ניתן להתקשר לאפס שלוש, חמש אחת שלוש, אפס אפס אפס שלוש.';
  return null;
}

function isWeatherQuestion(transcript) {
  return /(מזג.?האוויר|מזג האוויר|תחזית|טמפרטורה|כמה מעלות|גשם היום|ירד גשם|יהיה גשם|חם היום|קר היום|רוח היום)/i.test(String(transcript||''));
}

function isNewsQuestion(transcript) {
  return /(מה החדשות|חדשות היום|החדשות היום|מה חדש היום|מבזקי היום|חדשות עכשיו|מה קרה היום|חדשות אחרונות|חדשות ב|חדשות של|כותרות של|כותרות ב|ערוץ 14|ערוץ c14|c14|חדשות 12|חדשות 13|כאן 11|כאן חדשות|וואלה חדשות|ynet|ווינט|מעריב|ישראל היום)/i.test(String(transcript||''));
}

function isComedySearchQuestion(transcript) {
  return /(בדיחות|בדיחה|מצחיק|מצחיקים|סטנד.?אפ|קומיקאי|קומיקאים|קטע קומי|מערכון|מערכונים)/i.test(String(transcript||''));
}

function extractWeatherLocation(transcript) {
  const q=String(transcript||'').replace(/[?.,!]/g,' ').replace(/\s+/g,' ').trim();
  const match=q.match(/(?:ב|של|ל|בעיר)\s+([א-תA-Za-z][א-תA-Za-z' -]{1,35})(?=\s+(?:היום|עכשיו|מחר|למחר|בסוף|בלילה|בבוקר|בערב)|$)/i);
  if(match && match[1]) return match[1].trim();
  const cities=['תל אביב','ירושלים','חיפה','באר שבע','נתניה','כפר סבא','רעננה','הרצליה','פתח תקווה','ראשון לציון','אשדוד','אשקלון','רחובות','מודיעין','אילת','נצרת','עכו','טבריה'];
  return cities.find(city=>q.includes(city)) || null;
}

async function answerWeatherDirect(transcript) {
  const location=extractWeatherLocation(transcript);
  if(!location) return 'כדי לתת תמונת מזג אוויר מדויקת, אמור בבקשה את שם העיר.';
  const geoUrl=new URL('https://geocoding-api.open-meteo.com/v1/search');
  geoUrl.searchParams.set('name',location);
  geoUrl.searchParams.set('count','1');
  geoUrl.searchParams.set('language','he');
  geoUrl.searchParams.set('format','json');
  const geoResponse=await withTimeout(fetch(geoUrl),REQUEST_TIMEOUT_MS,'weather geocoding');
  if(!geoResponse.ok) throw Object.assign(new Error('Weather geocoding HTTP '+geoResponse.status),{status:503});
  const geo=await geoResponse.json();
  const place=geo?.results?.[0];
  if(!place) return 'לא מצאתי את העיר שביקשת. אמור שם עיר אחר.';

  const weatherUrl=new URL('https://api.open-meteo.com/v1/forecast');
  weatherUrl.searchParams.set('latitude',String(place.latitude));
  weatherUrl.searchParams.set('longitude',String(place.longitude));
  weatherUrl.searchParams.set('current','temperature_2m,apparent_temperature,precipitation,rain,weather_code,wind_speed_10m');
  weatherUrl.searchParams.set('daily','weather_code,temperature_2m_max,temperature_2m_min,precipitation_probability_max');
  weatherUrl.searchParams.set('forecast_days','2');
  weatherUrl.searchParams.set('timezone','Asia/Jerusalem');
  const weatherResponse=await withTimeout(fetch(weatherUrl),REQUEST_TIMEOUT_MS,'current weather');
  if(!weatherResponse.ok) throw Object.assign(new Error('Weather HTTP '+weatherResponse.status),{status:503});
  const weather=await weatherResponse.json();
  const current=weather?.current;
  const daily=weather?.daily;
  if(!current || !daily) throw Object.assign(new Error('Weather data missing'),{status:503});

  const codes={0:'שמיים בהירים',1:'בעיקר בהיר',2:'מעונן חלקית',3:'מעונן',45:'ערפל',48:'ערפל',51:'טפטוף קל',53:'טפטוף',55:'טפטוף חזק',61:'גשם קל',63:'גשם',65:'גשם חזק',71:'שלג קל',73:'שלג',75:'שלג כבד',80:'ממטרים קלים',81:'ממטרים',82:'ממטרים חזקים',95:'סופת רעמים',96:'סופת רעמים',99:'סופת רעמים'};
  const temp=Math.round(Number(current.temperature_2m));
  const feels=Math.round(Number(current.apparent_temperature));
  const wind=Math.round(Number(current.wind_speed_10m));
  const condition=codes[current.weather_code] || 'תנאי מזג אוויר לא ידועים';
  let answer='ב'+sanitizeForYemot(place.name||location)+' כרגע '+condition+', הטמפרטורה '+temp+' מעלות ומרגיש כמו '+feels+' מעלות, עם רוח של כ'+wind+' קילומטר לשעה.';
  const max=Number(daily.temperature_2m_max?.[0]), min=Number(daily.temperature_2m_min?.[0]), rainChance=Number(daily.precipitation_probability_max?.[0]);
  const todayCondition=codes[daily.weather_code?.[0]] || condition;
  if(Number.isFinite(min)&&Number.isFinite(max)) answer+=' לאורך היום צפויות בערך '+min+' עד '+max+' מעלות, ובאופן כללי צפוי '+todayCondition+'.';
  if(Number.isFinite(rainChance)) answer+=' הסיכוי המרבי למשקעים היום הוא כ'+rainChance+' אחוזים.';
  return answer;
}
async function answerNewsDirect(transcript, historyText='') {
  const question=String(transcript||'').trim();
  const history=String(historyText||'').trim();
  const sourceMatch=question.match(/(?:ערוץ|חדשות|כותרות)\s*(14|c14|12|13|11)/i);
  const source=sourceMatch ? String(sourceMatch[1]).toUpperCase()==='C14' ? 'ערוץ 14' : 'ערוץ '+sourceMatch[1] : '';
  const sourceQueries = {
    'ערוץ 14': 'site:c14.co.il חדשות היום',
    'ערוץ 12': 'site:mako.co.il/news חדשות היום',
    'ערוץ 13': 'site:13tv.co.il חדשות היום',
    'ערוץ 11': 'site:kan.org.il חדשות היום'
  };
  let q=source ? (sourceQueries[source] || source+' חדשות היום') :
    /(חדשות היום|מה החדשות|החדשות היום|חדשות עכשיו|חדשות אחרונות|מה המצב בישראל|מה קורה בישראל)/i.test(question)
      ? 'חדשות ישראל היום'
      : question.slice(0,100);

  const numberMatch=question.match(/(?:כותרת|הכותרת|חדשה)\s*(?:מספר\s*)?(\d+)/i);
  if(numberMatch && history) {
    const n=Number(numberMatch[1]);
    const marker=new RegExp('(?:כותרת|תוצאה)\\s*'+n+'\\s*[:.]\\s*([\\s\\S]*?)(?=(?:כותרת|תוצאה)\\s*\\d+\\s*[:.]|$)','i');
    const matches=history.match(marker);
    const title=matches?.[1]?.trim();
    if(title) q=title.slice(0,180);
  }

  const url='https://news.google.com/rss/search?q='+encodeURIComponent(q)+'&hl=he&gl=IL&ceid=IL:he';
  const response=await withTimeout(fetch(url),REQUEST_TIMEOUT_MS,'news RSS');
  if(!response.ok) throw Object.assign(new Error('News RSS HTTP '+response.status),{status:503});
  const xml=await response.text();

  function decodeXml(value) {
    return String(value||'')
      .replace(/<!\[CDATA\[|\]\]>/g,'')
      .replace(/&amp;/g,'&').replace(/&quot;/g,'"').replace(/&#39;/g,"'")
      .replace(/&lt;/g,'<').replace(/&gt;/g,'>');
  }
  function tagValue(block,tag) {
    const open='<'+tag;
    const start=block.indexOf('>',block.indexOf(open));
    if(start<0) return '';
    const end=block.indexOf('</'+tag+'>',start+1);
    if(end<0) return '';
    return decodeXml(block.slice(start+1,end).replace(/<[^>]+>/g,' ').trim());
  }

  const items=xml.split('<item>').slice(1,13).map(block=>({
    title:tagValue(block,'title'),
    pub:tagValue(block,'pubDate'),
    description:tagValue(block,'description'),
    source:tagValue(block,'source')
  })).filter(x=>x.title);
  if(!items.length) throw Object.assign(new Error('No news items'),{status:503});

  const raw=items.map((x,i)=>'מקור '+(i+1)+': '+x.title+(x.source?' | '+x.source:'')+(x.description?' | '+x.description.slice(0,700):'')).join('\n');
  try {
    const prompt=`${EXCLUSIVE_INSTRUCTION}
אתה מסכם חדשות עדכניות למענה קולי בטלפון.
השאלה: ${question}
להלן עדכוני חדשות שנאספו עכשיו ממקורות חדשות:
${raw}

ענה בעברית ובצורה טבעית שמתאימה לטלפון.
אם המתקשר ביקש מקור חדשות מסוים, למשל "מה החדשות בערוץ 14", "מה חדש ב-C14" או "מה החדשות בערוץ 12", אל תענה בחדשות כלליות: התמקד רק בדיווחים שמגיעים מהמקור שביקש, ובדוק שהכותרות באמת שייכות אליו. אם אין מספיק מידע מהמקור המדויק, אמור זאת והסבר בקצרה מה כן נמצא.
אם נשאלת "מה החדשות היום" או "מה המצב בישראל" בלי מקור מסוים — תן תמונת מצב כללית של 3 עד 5 נושאים מרכזיים, עם משפט או שניים לכל נושא.
אם נשאלת שאלה על נושא מסוים או מבקשים "יותר פרטים", התמקד רק בנושא הזה והרחב.
הפרד בין עובדות שדווחו לבין טענות או דיווחים שעדיין אינם מאומתים.
אל תמציא מידע שאינו מופיע בחומר.
התשובה מיועדת להקראה בטלפון, ולכן קצרה, טבעית וברורה.`;
    const result=await generateWithRetry([{role:'user',parts:[{text:prompt}]}],false,false);
    const answer=String(result?.response?.text?.()||'').trim();
    if(answer) return answer;
  } catch(e) {
    console.warn('[News] synthesis unavailable',{status:geminiErrorStatus(e),message:String(e?.message||e).slice(0,400)});
  }
  const compact=items.slice(0,5).map(x=>sanitizeForYemot(x.title)).join('. ');
  return 'תמונת המצב העיקרית בחדשות כרגע כוללת כמה נושאים מרכזיים: '+compact+'. אם תרצה, שאל אותי על אחד מהם ואפרט.';
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

function extractPublicUrl(text) {
  const match=String(text||'').match(/https?:\/\/[^\s<>]+/i);
  if(!match) return '';
  return match[0].replace(/[.,!?;:]+$/,'');
}

function isMultimodalAnalysisRequest(text) {
  const q=String(text||'').toLowerCase();
  const asksVisual=/(תמונה|תמונות|צילום|צילום מסך|תצלום|מה רואים|איך נראה|איך הוא נראה|איך היא נראית|תמחיש|המחשה|להמחיש|תראה לי|תאר לי איך|מה הייתי רואה|תתאר.*תמונה|נתח.*תמונה|תנתח.*תמונה|תאר.*תמונה|תיאור.*תמונה|מה מופיע בתמונה|מה יש בתמונה)/i.test(q);
  const asksVideo=/(סרטון|סירטון|סרט|וידאו|קליפ|הסרט הזה|הסרטון הזה|מה רואים בסרטון|מה שומעים בסרטון|תנתח.*סרטון|נתח.*סרטון|תיאור.*סרטון|מה קורה בסרטון|מה מופיע בסרטון|מה הוא עושה בסרטון|מה היא עושה בסרטון|תספר.*סרטון|תמחיש.*סרט|המחשה.*סרט|תמחיש.*וידאו)/i.test(q);
  const genericVideoVisual=/(תמחיש|המחשה|להמחיש|איך הוא נראה|איך היא נראית|מה רואים|מה קורה|מה הוא עושה|מה היא עושה|תראה לי|תאר לי)/i.test(q) &&
    /(סרט|סרטון|וידאו|קליפ|יוטיוב|יוטוב|ביויוטב)/i.test(q);
  const asksSite=/(תנתח.*אתר|נתח.*אתר|תסביר.*אתר|מה יש באתר|מה כתוב באתר|תיאור.*אתר)/i.test(q);
  return {image:asksVisual&&!asksVideo,video:asksVideo||genericVideoVisual,site:asksSite,any:asksVisual||asksVideo||genericVideoVisual||asksSite};
}

function extractMetaUrl(html, wantedNames) {
  const source=String(html||'');
  const wanted=new Set(wantedNames.map(x=>x.toLowerCase()));
  const tags=source.match(/<meta\b[^>]*>/gi)||[];
  for(const tag of tags) {
    const attrs={};
    for(const m of tag.matchAll(/([a-zA-Z_:][-a-zA-Z0-9_:]*)\s*=\s*["']([^"']*)["']/g)) attrs[m[1].toLowerCase()]=m[2];
    const name=String(attrs.property||attrs.name||'').toLowerCase();
    const content=String(attrs.content||'').trim();
    if(wanted.has(name) && content) return decodeHtmlEntities(content);
  }
  return '';
}

async function analyzePublicImageUrl(imageUrl, question) {
  const mediaDedicatedKey=String(process.env.MEDIA_GEMINI_API_KEY||'').trim();
  const candidateKeys=[...(mediaDedicatedKey?[mediaDedicatedKey]:[]),...apiKeys,...(BRANCH1_BACKUP_GEMINI_API_KEY?[BRANCH1_BACKUP_GEMINI_API_KEY]:[])].filter(Boolean);
  if(!candidateKeys.length) throw Object.assign(new Error('Gemini key unavailable for image analysis'),{status:503});

  let response=await withTimeout(fetch(imageUrl,{redirect:'follow',headers:{'user-agent':'Mozilla/5.0 (compatible; YemotAI/1.0)'}}),MEDIA_ANALYSIS_TIMEOUT_MS,'media image fetch');
  if(!response.ok) throw Object.assign(new Error('Image fetch HTTP '+response.status),{status:502});
  let mime=String(response.headers.get('content-type')||'').split(';')[0].trim().toLowerCase();
  let bytes=Buffer.from(await response.arrayBuffer());

  if(!mime.startsWith('image/')) {
    const discovered=extractMetaUrl(bytes.toString('utf8'),['og:image','twitter:image','twitter:image:src']);
    if(!discovered) throw Object.assign(new Error('No public image found at URL'),{status:415});
    const discoveredUrl=new URL(discovered,new URL(imageUrl)).toString();
    response=await withTimeout(fetch(discoveredUrl,{redirect:'follow',headers:{'user-agent':'Mozilla/5.0 (compatible; YemotAI/1.0)'}}),MEDIA_ANALYSIS_TIMEOUT_MS,'media discovered image fetch');
    if(!response.ok) throw Object.assign(new Error('Discovered image HTTP '+response.status),{status:502});
    mime=String(response.headers.get('content-type')||'').split(';')[0].trim().toLowerCase();
    bytes=Buffer.from(await response.arrayBuffer());
  }

  if(!mime.startsWith('image/')) throw Object.assign(new Error('Unsupported image content type'),{status:415});
  if(bytes.length>MEDIA_MAX_IMAGE_BYTES) throw Object.assign(new Error('Image too large for phone analysis'),{status:413});

  const configuredMediaModel=(process.env.MEDIA_GEMINI_MODEL||'gemini-3.8-flash').trim();
  const mediaModels=[...new Set([configuredMediaModel,'gemini-3.8-flash','gemini-3.6-flash','gemini-3.5-flash-lite','gemini-3.1-flash-lite'])].filter(Boolean);
  const prompt='נתח את התמונה עצמה, לא רק את כתובת המקור. השאלה של המתקשר: '+String(question||'תאר את התמונה בפירוט')+
    '\nתן תיאור מפורט, מדויק וטבעי בעברית: מה נראה, אנשים או בעלי חיים אם יש, חפצים, סביבה, טקסט קריא, צבעים, מיקום יחסי, פעולות ואירועים שניתן להסיק בביטחון. הפרד בין מה שנראה בבירור לבין מה שאינו ודאי. אם יש טקסט בתמונה, קרא אותו רק אם הוא קריא. התשובה מיועדת להקראה בטלפון.';
  let lastError=null;

  for(let ki=0;ki<candidateKeys.length;ki++){
    for(const model of mediaModels){
      try{
        const r=await withTimeout(fetch('https://generativelanguage.googleapis.com/v1beta/interactions',{
          method:'POST',
          headers:{'x-goog-api-key':candidateKeys[ki],'Content-Type':'application/json'},
          body:JSON.stringify({model,store:false,input:[
            {type:'text',text:prompt},
            {type:'image',data:bytes.toString('base64'),mime_type:mime}
          ]})
        }),MEDIA_ANALYSIS_TIMEOUT_MS,'Gemini image analysis');
        const data=await r.json().catch(()=>({}));
        if(!r.ok){
          const e=Object.assign(new Error(data?.error?.message||('Gemini image analysis HTTP '+r.status)),{status:r.status});
          lastError=e;
          if([400,401,403,404,415,422].includes(r.status)) break;
          continue;
        }
        const out=String(data?.output_text||'').trim();
        if(out) return out;
        const blocks=(data?.steps||[]).flatMap(x=>x?.content||[]).filter(x=>x?.type==='text').map(x=>x.text||'');
        const joined=blocks.join(' ').trim();
        if(joined) return joined;
        lastError=Object.assign(new Error('Gemini image analysis returned empty output'),{status:503});
      }catch(e){
        lastError=e;
        const status=geminiErrorStatus(e);
        if(status===400||status===401||status===403||status===404||status===415||status===422) break;
      }
    }
  }
  throw lastError||Object.assign(new Error('Image analysis unavailable'),{status:503});
}

async function readResponseBufferLimited(response, maxBytes, label) {
  if(!response?.body) {
    const buffer=Buffer.from(await response.arrayBuffer());
    if(buffer.length>maxBytes) throw Object.assign(new Error(label+' exceeds configured size limit'),{status:413});
    return buffer;
  }
  const reader=response.body.getReader();
  const chunks=[];
  let total=0;
  try {
    while(true) {
      const {done,value}=await reader.read();
      if(done) break;
      total+=value.byteLength;
      if(total>maxBytes) {
        try { await reader.cancel(); } catch {}
        throw Object.assign(new Error(label+' exceeds configured size limit'),{status:413});
      }
      chunks.push(Buffer.from(value));
    }
  } finally {
    try { reader.releaseLock(); } catch {}
  }
  return Buffer.concat(chunks,total);
}

async function analyzePublicVideoUrl(videoUrl, question) {
  const mediaDedicatedKey=String(process.env.MEDIA_GEMINI_API_KEY||'').trim();
  const candidateKeys=[...(mediaDedicatedKey?[mediaDedicatedKey]:[]),...apiKeys,...(BRANCH1_BACKUP_GEMINI_API_KEY?[BRANCH1_BACKUP_GEMINI_API_KEY]:[])].filter(Boolean);
  if(!candidateKeys.length) throw Object.assign(new Error('Gemini key unavailable for video analysis'),{status:503});
  const configuredMediaModel=(process.env.MEDIA_GEMINI_MODEL||process.env.YOUTUBE_GEMINI_MODEL||'gemini-3.1-flash-lite').trim();
  const mediaModels=[...new Set([configuredMediaModel,'gemini-3.1-flash-lite','gemini-3.5-flash-lite','gemini-3.6-flash','gemini-3.8-flash'])].filter(Boolean);
  const isYouTube=/^(?:https?:\/\/)?(?:www\.)?(?:youtube\.com|youtu\.be)\//i.test(videoUrl);
  let videoInput;

  if(isYouTube){
    const useAgenticVideo=/^gemini-3\\.(8|7|6)-flash$|^gemini-3\\.5-flash-lite$/i;
    videoInput={type:'video',uri:videoUrl,...(useAgenticVideo.test(mediaModels[0])?{processing:'agentic'}:{})};
  } else {
    const response=await withTimeout(fetch(videoUrl,{redirect:'follow',headers:{'user-agent':'Mozilla/5.0 (compatible; YemotAI/1.0)'}}),MEDIA_ANALYSIS_TIMEOUT_MS,'public video fetch');
    if(!response.ok) throw Object.assign(new Error('Public video HTTP '+response.status),{status:502});
    const mime=String(response.headers.get('content-type')||'').split(';')[0].trim().toLowerCase();
    const contentLength=Number(response.headers.get('content-length')||0);
    if(contentLength && contentLength>MEDIA_MAX_VIDEO_BYTES) throw Object.assign(new Error('Video too large for phone analysis'),{status:413});
    if(!mime.startsWith('video/') && !/\.(mp4|webm|mov|mpeg|mpg|avi|wmv|3gp)(?:\?|$)/i.test(videoUrl))
      throw Object.assign(new Error('Public URL is not a supported video'),{status:415});
    const bytes=await readResponseBufferLimited(response,MEDIA_MAX_VIDEO_BYTES,'Public video');
    videoInput={type:'video',data:bytes.toString('base64'),mime_type:mime||'video/mp4'};
  }

  const prompt='נתח את הסרטון עצמו, לא רק את הכותרת, התיאור או המטא-דאטה, כולל המידע החזותי והשמע. השאלה של המתקשר: '+String(question||'תמחיש את הסרטון בפירוט')+
    '\nתן המחשה קולית מפורטת ומעמיקה בעברית: איך הסרטון נראה מתחילתו, מי או מה מופיע, לבוש ומראה כללי שניתן לראות, המקום והסביבה, מה כל אדם או אובייקט עושה, רצף האירועים והשינויים בין הסצנות, טקסטים שמופיעים על המסך, ומה נאמר או נשמע כאשר ניתן לקבוע זאת. אם יש תנועה מהירה או רגע חשוב, נסה לאתר אותו ולציין זמן רלוונטי. הפרד בבירור בין מה שנצפה לבין השערה, ואל תמציא פרטים. התשובה מיועדת להקראה בטלפון ולכן היא צריכה ממש לעזור למאזין לדמיין את הסרטון.';
  let lastError=null;

  for(let ki=0;ki<candidateKeys.length;ki++){
    for(const model of mediaModels){
      try{
        const agentic=/^gemini-3\\.(8|7|6)-flash$|^gemini-3\\.5-flash-lite$/i.test(model);
        const input=isYouTube
          ? {...videoInput,...(agentic?{processing:'agentic'}:{})}
          : videoInput;
        const r=await withTimeout(fetch('https://generativelanguage.googleapis.com/v1beta/interactions',{
          method:'POST',
          headers:{'x-goog-api-key':candidateKeys[ki],'Content-Type':'application/json'},
          body:JSON.stringify({model,store:false,input:[input,{type:'text',text:prompt}]})
        }),MEDIA_ANALYSIS_TIMEOUT_MS,'Gemini video analysis');
        const data=await r.json().catch(()=>({}));
        if(!r.ok){
          lastError=Object.assign(new Error(data?.error?.message||('Gemini video analysis HTTP '+r.status)),{status:r.status});
          if([400,401,403,404,415,422].includes(r.status)) break;
          continue;
        }
        const out=String(data?.output_text||'').trim();
        if(out) return out;
        const blocks=(data?.steps||[]).flatMap(x=>x?.content||[]).filter(x=>x?.type==='text').map(x=>x.text||'');
        const joined=blocks.join(' ').trim();
        if(joined) return joined;
        lastError=Object.assign(new Error('Gemini video analysis returned empty output'),{status:503});
      }catch(e){
        lastError=e;
        const status=geminiErrorStatus(e);
        if(status===400||status===401||status===403||status===404||status===415||status===422) break;
      }
    }
  }
  throw lastError||Object.assign(new Error('Video analysis unavailable'),{status:503});
}

function extractVisualSubject(question, historyText='') {
  const q=String(question||'').trim();
  const h=String(historyText||'');
  const clean=(x)=>String(x||'')
    .replace(/(?:איך|כיצד)\s*(?:הוא|היא|זה|זו)?\s*(?:נראה|נראית|נראים|נראות)/gi,' ')
    .replace(/(?:תמחיש|המחשה|להמחיש|תראה לי|תאר לי|תיאור חזותי|מה רואים|מה קורה)/gi,' ')
    .replace(/(?:תמצא|תמצאי|מצא|חפש|תחפש|חיפוש|משהו|תמונה|צילום|ציבורי|מקור|קישור|קישור ציבורי|תנסה שוב|שוב)/gi,' ')
    .replace(/[?!.:,;]+/g,' ')
    .replace(/\s+/g,' ').trim();
  const direct=clean(q);
  const looksLikeContinuation=/(תמצא|תמצאי|מצא|חפש|תחפש|מחפש|מחפשת|תנסה שוב|נסה שוב|שוב|שלו|שלה|אותו|אותה|הפיזי|הפיזית)/i.test(q);
  const turns=h.split(/\n\s*\n|(?=תור\s*\d+)/).reverse();
  // For a follow-up that refers to "him/her/the same one", prefer the last
  // explicit visual subject from the conversation instead of treating words
  // such as "מחפש" or "תנסה שוב" as the subject itself.
  if(looksLikeContinuation){
    for(const turn of turns){
      const m=turn.match(/מתקשר:\s*([^\n]+)/i);
      if(m && /איך\s+(?:הוא|היא)?\s*נראה|איך\s*נראית|תמחיש|תמונה|צילום|תיאור\s*(?:חזותי|הפיזי)|מה\s*רואים/i.test(m[1])){
        const t=clean(m[1]);
        if(t.length>=3 && !/^(איך|נראה|תמונה|צילום)$/i.test(t)) return t;
      }
    }
  }
  if(direct && direct.length>=3 && !/^(אותו|אותה|זה|זו|שם האדם|האדם)$/i.test(direct)) return direct;
  for(const turn of turns){
    const m=turn.match(/מתקשר:\s*([^\n]+)/i);
    if(m){
      const t=clean(m[1]);
      if(/איך|נראה|נראית|תמחיש|תמונה|צילום|חזות/i.test(m[1]) && t.length>=3) return t;
    }
  }
  return direct;
}

function isVisualContinuationRequest(text, historyText='') {
  const q=String(text||'').trim();
  const h=String(historyText||'');
  const continuation=/(תמצא|תמצאי|מצא|חפש|תחפש|מחפש|מחפשת|חיפוש|משהו ציבורי|מקור ציבורי|תמונה ציבורית|תמונה כלשהי|תמונה כל שהוא|קישור ציבורי|קישור כלשהו|תנסה שוב|נסה שוב|שוב|תיאור הפיזי|תיאור חזותי|איך הוא|איך היא|שלו|שלה|אותו|אותה)/i.test(q);
  const visualHistory=/(איך נראה|איך היא נראית|איך הוא נראה|תמחיש|המחשה|תמונה|צילום|סרטון|וידאו|תיאור חזותי|תיאור הפיזי|מה רואים)/i.test(h);
  return continuation && visualHistory;
}

async function findPublicImageFromOpenSources(question, historyText='') {
  const subject=extractVisualSubject(question,historyText);
  if(!subject) return [];
  const candidates=[];
  const add=(u)=>{ if(u && /^https?:\/\//i.test(u) && !candidates.includes(u)) candidates.push(u); };

  const endpoints=[
    'https://commons.wikimedia.org/w/api.php?action=query&format=json&formatversion=2&generator=search&gsrsearch='+encodeURIComponent(subject)+'&gsrnamespace=6&gsrlimit=8&prop=imageinfo&iiprop=url|mime&iiurlwidth=1200&redirects=1',
    'https://he.wikipedia.org/w/api.php?action=query&format=json&formatversion=2&generator=search&gsrsearch='+encodeURIComponent(subject)+'&gsrnamespace=0&gsrlimit=6&prop=pageimages&piprop=thumbnail&pilicense=any&pithumbsize=1000&redirects=1',
    'https://en.wikipedia.org/w/api.php?action=query&format=json&formatversion=2&generator=search&gsrsearch='+encodeURIComponent(subject)+'&gsrnamespace=0&gsrlimit=6&prop=pageimages&piprop=thumbnail&pilicense=any&pithumbsize=1000&redirects=1'
  ];
  for(const endpoint of endpoints){
    try{
      const r=await withTimeout(fetch(endpoint,{headers:{'user-agent':'Mozilla/5.0 (compatible; YemotAI/1.0)'}}),7000,'Wikipedia image search');
      if(!r.ok) continue;
      const data=await r.json().catch(()=>null);
      for(const page of (data?.query?.pages||[])) {
        const info=page?.imageinfo?.[0];
        if(info && String(info.mime||'').startsWith('image/')) add(info.thumburl||info.url);
        add(page?.thumbnail?.source);
      }
    }catch{}
    if(candidates.length>=MEDIA_MAX_CANDIDATES) break;
  }

  // YouTube is an independent source from Gemini quota and its thumbnails are
  // public image URLs. Use it when Wikipedia has no suitable picture.
  if(candidates.length<MEDIA_MAX_CANDIDATES){
    try{
      const ytKey=(process.env.YOUTUBE_API_KEY||'').trim();
      if(ytKey){
        const videos=await searchYouTubeVideos(subject,{apiKey:ytKey,regionCode:process.env.YOUTUBE_REGION_CODE||'IL',timeoutMs:REQUEST_TIMEOUT_MS});
        for(const v of (videos||[]).slice(0,MEDIA_MAX_CANDIDATES)){
          add(v.thumbnail||v.thumbnails?.high?.url||v.thumbnails?.medium?.url||v.thumbnails?.default?.url);
          if(candidates.length>=MEDIA_MAX_CANDIDATES) break;
        }
      }
    }catch{}
  }
  return candidates.slice(0,MEDIA_MAX_CANDIDATES);
}

async function findPublicImageForVisualQuery(question, historyText='') {

  const candidateKeys=[...apiKeys, ...(BRANCH1_BACKUP_GEMINI_API_KEY?[BRANCH1_BACKUP_GEMINI_API_KEY]:[])].filter(Boolean);
  if(!candidateKeys.length) throw Object.assign(new Error('Gemini key unavailable for public visual search'),{status:503});
  const configuredMediaModel=(process.env.MEDIA_GEMINI_MODEL||'gemini-3.8-flash').trim();
  const mediaModels=[...new Set([configuredMediaModel,'gemini-3.6-flash','gemini-3.5-flash-lite'])].filter(Boolean);
  const searchPrompt='חפש באינטרנט מקורות ציבוריים שמכילים תמונה אמיתית וברורה של האדם או הנושא שביקש המתקשר לראות. בקשת המתקשר: '+String(question||'')+
    '\nהחזר מקורות ציבוריים נגישים. העדף אתר רשמי, עמוד ציבורי מזוהה, מקור חדשותי או אנציקלופדי מוכר. אל תנחש זהות. חשוב למצוא תמונה שאפשר לנתח בפועל, לא רק עמוד טקסט.';
  const urls=[];
  let lastError=null;

  for(const key of candidateKeys){
    for(const model of mediaModels){
      try{
        const r=await withTimeout(fetch('https://generativelanguage.googleapis.com/v1beta/interactions',{
          method:'POST',
          headers:{'x-goog-api-key':key,'Content-Type':'application/json'},
          body:JSON.stringify({model,store:false,input:searchPrompt,tools:[{type:'google_search'}]})
        }),MEDIA_SEARCH_TIMEOUT_MS,'public visual web search');
        const data=await r.json().catch(()=>({}));
        if(!r.ok){
          lastError=Object.assign(new Error(data?.error?.message||('Public visual search HTTP '+r.status)),{status:r.status});
          if([400,401,403,404,422].includes(r.status)) break;
          continue;
        }
        for(const step of (data?.steps||[])){
          for(const block of (step?.content||[])){
            for(const ann of (block?.annotations||[])){
              const u=String(ann?.url||ann?.url_citation?.url||'').trim();
              if(/^https?:\/\//i.test(u) && !urls.includes(u)) urls.push(u);
            }
          }
        }
        const out=String(data?.output_text||'');
        for(const m of out.matchAll(/https?:\/\/[^\s)]+/gi)){
          const u=m[0].replace(/[.,;]+$/,'');
          if(!urls.includes(u)) urls.push(u);
        }
        if(urls.length>=MEDIA_MAX_CANDIDATES) break;
      }catch(e){
        lastError=e;
      }
    }
    if(urls.length>=MEDIA_MAX_CANDIDATES) break;
  }

  const candidates=[];
  for(const pageUrl of urls.slice(0,Math.max(MEDIA_MAX_CANDIDATES,8))){
    try{
      const response=await withTimeout(fetch(pageUrl,{redirect:'follow',headers:{'user-agent':'Mozilla/5.0 (compatible; YemotAI/1.0)'}}),10000,'public image page fetch');
      if(!response.ok) continue;
      const mime=String(response.headers.get('content-type')||'').split(';')[0].trim().toLowerCase();
      if(mime.startsWith('image/')){
        if(!candidates.includes(pageUrl)) candidates.push(pageUrl);
        continue;
      }
      const html=Buffer.from(await response.arrayBuffer()).toString('utf8');
      const image=extractMetaUrl(html,['og:image','twitter:image','twitter:image:src']);
      if(image){
        try{
          const imageUrl=new URL(image,pageUrl).toString();
          if(!candidates.includes(imageUrl)) candidates.push(imageUrl);
        }catch{}
      }
    }catch{}
    if(candidates.length>=MEDIA_MAX_CANDIDATES) break;
  }

  // Last-resort public visual source: a YouTube result thumbnail. This avoids asking
  // the caller for a link when the public web search found the person but no image page
  // was directly downloadable.
  if(!candidates.length){
    try{
      const ytKey=(process.env.YOUTUBE_API_KEY||'').trim();
      if(ytKey){
        const videos=await searchYouTubeVideos(String(question||'').replace(/איך.*?נראה|איך.*?נראית|תמחיש|המחשה|תראה לי|תאר לי/gi,'').trim(),{
          apiKey:ytKey,regionCode:process.env.YOUTUBE_REGION_CODE||'IL',timeoutMs:REQUEST_TIMEOUT_MS
        });
        for(const v of (videos||[]).slice(0,MEDIA_MAX_CANDIDATES)){
          const thumb=v.thumbnail||v.thumbnails?.medium?.url||v.thumbnails?.default?.url||'';
          if(thumb && !candidates.includes(thumb)) candidates.push(thumb);
        }
      }
    }catch(e){ lastError=e; }
  }

  if(candidates.length) return candidates;
  throw lastError||Object.assign(new Error('No public visual source found'),{status:404});
}

async function analyzeRequestedMedia(question, context={}) {
  const historyText=String(context?.historyText||'');
  const visualContinuation=isVisualContinuationRequest(question,historyText);
  const intent=isMultimodalAnalysisRequest(question);
  if(visualContinuation && !intent.any) intent.image=true, intent.any=true;
  if(!intent.any) return null;
  const explicitUrl=extractPublicUrl(question);
  const youtubeVideo=context?.currentVideo?.videoId
    ? 'https://www.youtube.com/watch?v='+context.currentVideo.videoId : '';
  let urls=explicitUrl?[explicitUrl]:[];
  if(!urls.length && youtubeVideo) urls=[youtubeVideo];
  if(!urls.length && intent.video && context?.youtubeResults?.length){
    const candidate=context.youtubeResults[0];
    if(candidate?.videoId) urls=['https://www.youtube.com/watch?v='+candidate.videoId];
  }
  if(!urls.length && intent.image && !intent.video){
    urls=await findPublicImageForVisualQuery(question,historyText);
  }
  if(!urls.length) throw Object.assign(new Error('לא מצאתי מקור ציבורי מתאים לניתוח החזותי.'),{status:404});

  if(intent.site && !intent.image && !intent.video){
    const key=apiKeys[0]||'';
    if(!key) throw Object.assign(new Error('Gemini key unavailable for site analysis'),{status:503});
    const model=(process.env.MEDIA_GEMINI_MODEL||'gemini-3.8-flash').trim();
    const r=await withTimeout(fetch('https://generativelanguage.googleapis.com/v1beta/interactions',{
      method:'POST',headers:{'x-goog-api-key':key,'Content-Type':'application/json'},
      body:JSON.stringify({model,store:false,input:'נתח את האתר הבא לפי בקשת המתקשר. כתובת: '+urls[0]+'\\nבקשה: '+question,tools:[{type:'url_context'}]})
    }),MEDIA_ANALYSIS_TIMEOUT_MS,'Gemini site analysis');
    const data=await r.json().catch(()=>({}));
    if(!r.ok) throw Object.assign(new Error(data?.error?.message||('Gemini site analysis HTTP '+r.status)),{status:r.status});
    return String(data?.output_text||'').trim();
  }

  let lastError=null;
  for(const url of urls.slice(0,MEDIA_MAX_CANDIDATES)){
    try{
      if(intent.video || /(?:youtube\.com|youtu\.be)/i.test(url)) return await analyzePublicVideoUrl(url,question);
      return await analyzePublicImageUrl(url,question);
    }catch(e){
      lastError=e;
      console.warn('[MULTIMODAL] candidate failed; trying next public source',{status:geminiErrorStatus(e),message:String(e?.message||e).slice(0,220)});
    }
  }
  throw lastError||Object.assign(new Error('All public visual candidates failed'),{status:503});
}

function wantsYouTubeVideoFollowUp(text) {
  return /(על מה|מה דיברו|מה דיבר|מה אמרו|מה נאמר|מה היה|מה קרה בסרטון|מה בדיוק|תוכן הסרטון|תוכן השיר|מילים|סכם|סיכום|תספר לי מה יש|כמה צפיות|מספר צפיות|צפיות|כמה לייקים|לייקים|כמה תגובות|תגובות|מה אומרים בתגובות|מה כתבו בתגובות|פרטי הסרטון|פרטים על הסרטון|מידע על הסרטון|מתי עלה|מתי פורסם|תאריך הפרסום|תיאור הסרטון|מי העלה|באיזה ערוץ|שם הערוץ)/i.test(String(text||''));
}

async function searchYouTubeForPhone(transcript, historyText='', context={}) {
  const key=((arguments[3]||'').trim() || process.env.YOUTUBE_API_KEY || '').trim();
  if(!key) return null;
  const question=String(transcript||'').trim();
  if(!question) return null;
  const explicitYouTube=/(youtube|יוטיוב|ביויוטב|ביוטוב)/i.test(question);
  const hasResultReference=/(?:תוצאה|סרטון|בדיחה)\s*(?:מספר\s*)?(ראשונה|שנייה|שלישית|רביעית|חמישית|שישית|שביעית|שמינית|תשיעית|1|2|3|4|5|6|7|8|9)/i.test(question) ||
    /(?:הראשונה|השנייה|השלישית|הרביעית|החמישית|הראשון|השני|השלישי|הרביעי|החמישי)/i.test(question);
  const hasPinnedVideo=!!(context?.currentVideo?.videoId);
  if(!explicitYouTube && !hasResultReference && !hasPinnedVideo) return null;

  const wantsNewest=/(הכי חדש|החדש ביותר|הכי חדשה|האחרון|האחרונה|אחרון|אחרונה|העדכני ביותר|חדש ביותר|מה יצא לאחרונה|מה עלה לאחרונה|הכי חדש שעלה)/i.test(question);
  const wantsContent=/(על מה|מה דיברו|מה דיבר|מה אמרו|מה נאמר|מה היה|מה קרה בסרטון|מה בדיוק|הדו.?שיח|השיחה|תוכן הסרטון|תוכן השיר|תוכן הבדיחה|מילים|סכם|סיכום|תספר לי מה יש)/i.test(question);

  // Resolve references against the exact YouTube results already found in this call.
  let resolvedQuestion=question;
  let videos=[];
  const resultMatch=question.match(/(?:תוצאה|סרטון|בדיחה)\s*(?:מספר\s*)?(ראשונה|שנייה|שלישית|רביעית|חמישית|שישית|שביעית|שמינית|תשיעית|1|2|3|4|5|6|7|8|9)/i);
  if(resultMatch) {
    const words={ראשונה:1,שנייה:2,שלישית:3,רביעית:4,חמישית:5,שישית:6,שביעית:7,שמינית:8,תשיעית:9};
    const n=Number(resultMatch[1]) || words[resultMatch[1]];
    if(n && context && Array.isArray(context.youtubeResults) && context.youtubeResults[n-1]) {
      const previous=context.youtubeResults[n-1];
      if(wantsContent) {
        videos=[previous];
      } else {
        resolvedQuestion=previous.title;
      }
    } else if(n && historyText) {
      const marker=new RegExp('(?:תוצאה|סרטון)\\s*'+n+'\\s*[:.]\\s*([\\s\\S]*?)(?=תוצאה\\s*\\d+\\s*[:.]|$)','i');
      const match=historyText.match(marker);
      const previousTitle=match?.[1]?.split(/\\.\\s*(?:הערוץ|פורסם בתאריך)/i)[0]?.trim();
      if(previousTitle) resolvedQuestion=previousTitle;
    }
  }
  const wantsStats=/(כמה צפיות|כמה צפיות יש|מספר צפיות|צפיות|כמה לייקים|לייקים|כמה תגובות|תגובות|מה אומרים בתגובות|מה כתבו בתגובות|תגובות על הסרטון)/i.test(question);
  const wantsCommentDetails=/(יותר.*תגובות|פרטים.*תגובות|פירוט.*תגובות|בפירוט.*תגובות|דעות.*תגובות|מה אנשים חושבים|מה אנשים אומרים|מה חוזר בתגובות|מגמה בתגובות|תנתח.*תגובות|ניתוח.*תגובות)/i.test(question);
  const wantsDetails=/(פרטי הסרטון|פרטי סירטון|פרטים על הסרטון|פרטים על סירטון|מידע על הסרטון|מידע על סירטון|מתי עלה|מתי פורסם|תאריך הפרסום|תיאור הסרטון|תיאור של הסרטון|מי העלה|באיזה ערוץ|שם הערוץ)/i.test(question);
  if (context && Array.isArray(context.youtubeResults) && resultMatch && (wantsStats || wantsDetails)) {
    const words={ראשונה:1,שנייה:2,שלישית:3,רביעית:4,חמישית:5,שישית:6,שביעית:7,שמינית:8,תשיעית:9};
    const n=Number(resultMatch[1]) || words[resultMatch[1]];
    if (n && context.youtubeResults[n-1]) videos=[context.youtubeResults[n-1]];
  }

  const wantsVisualFollowUp=/(תמחיש|המחשה|להמחיש|איך הוא נראה|איך היא נראית|מה רואים|מה קורה|מה הוא עושה|מה היא עושה|תיאור חזותי|תאר לי)/i.test(question);
  if (hasPinnedVideo && (wantsContent || wantsStats || wantsDetails || wantsCommentDetails || wantsVisualFollowUp)) {
    videos=[context.currentVideo];
  }

  if (Array.isArray(context?.youtubeResults) && resultMatch && wantsContent) {
    const words={ראשונה:1,שנייה:2,שלישית:3,רביעית:4,חמישית:5,שישית:6,שביעית:7,שמינית:8,תשיעית:9};
    const n=Number(resultMatch[1]) || words[resultMatch[1]];
    if(n && context.youtubeResults[n-1]) videos=[context.youtubeResults[n-1]];
  }
  try {
    if (!videos.length) videos=await searchYouTubeVideos(resolvedQuestion,{
      apiKey:key,      regionCode:process.env.YOUTUBE_REGION_CODE||'IL',      timeoutMs:REQUEST_TIMEOUT_MS
    });
  } catch(e) {
    console.warn('[YouTube] structured search failed', {status:geminiErrorStatus(e),message:String(e?.message||'').slice(0,500)});
  }

  if(!videos.length) {
    let query=resolvedQuestion
      .replace(/(תחפש לי באינטרנט|תחפש באינטרנט|חפש באינטרנט|ביוטיוב|ביויוטב|ביוטוב|ב youtube|youtube)/gi,' ')
      .replace(/\\s+/g,' ').trim();
    // For natural requests such as "find a funny clip from X", remove
    // conversational filler and retry with the strongest search terms.
    query=query
      .replace(/^(תן לי|תביא לי|תמצא לי|תראה לי|אני רוצה|אני מחפש|אני רוצה לראות)\\s+/i,'')
      .replace(/^(בדיחה|בדיחות|קטע מצחיק|קטעים מצחיקים)\\s+(של|מ|בערוץ|בערוץ)\\s+/i,'')
      .trim().slice(0,120);
    const url=new URL('https://www.googleapis.com/youtube/v3/search');
    url.searchParams.set('part','snippet');
    url.searchParams.set('q',query);
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
    videos=(data.items||[]).filter(x=>x.id?.videoId).map(x=>({
      videoId:x.id.videoId,
      title:String(x.snippet?.title||'ללא כותרת'),
      channelTitle:String(x.snippet?.channelTitle||'ערוץ לא ידוע'),
      publishedAt:x.snippet?.publishedAt||null,
      description:String(x.snippet?.description||'')
    }));
  }

  if(!videos.length) return 'לא מצאתי כרגע תוצאה מתאימה ביוטיוב.';
  if (context && Array.isArray(context.youtubeResults) && videos.length && !resultMatch) {
    context.youtubeResults = videos.slice(0, 15);
  }
  // Keep the most relevant result available for the next natural follow-up.
  // This lets "תמחיש לי איך הוא נראה" refer to the video just found.
  if (context && videos.length) {
    context.currentVideo = videos[0];
  }
  if(wantsStats || wantsDetails) {
    try {
      const stats=await getYouTubeStats(videos.slice(0,10).map(v=>v.videoId));
      const target=videos[0];
      const item=stats.get(target.videoId);
      if(!item) return 'מצאתי את הסרטון אבל לא הצלחתי לקבל כרגע את נתוני YouTube.';
      const s=item.statistics||{};
      const snippet=item.snippet||{};
      const details=item.contentDetails||{};
      const live=item.liveStreamingDetails||{};
      let answer='הסרטון '+sanitizeForYemot(snippet.title||target.title||'')+
        '. הערוץ: '+sanitizeForYemot(snippet.channelTitle||target.channelTitle||'לא ידוע');
      if(snippet.publishedAt) answer+=', פורסם בתאריך '+new Intl.DateTimeFormat('he-IL',{timeZone:'Asia/Jerusalem',dateStyle:'full'}).format(new Date(snippet.publishedAt));
      if(details.duration) {
        const m=String(details.duration).match(/^PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?$/);
        if(m) answer+=', אורך הסרטון '+[m[1]?m[1]+' שעות':'',m[2]?m[2]+' דקות':'',m[3]?m[3]+' שניות':''].filter(Boolean).join(' ו');
      }
      if(s.viewCount!=null) answer+=', '+Number(s.viewCount).toLocaleString('he-IL')+' צפיות';
      if(s.likeCount!=null) answer+=', '+Number(s.likeCount).toLocaleString('he-IL')+' לייקים';
      if(s.commentCount!=null) answer+=' ו-'+Number(s.commentCount).toLocaleString('he-IL')+' תגובות';
      if(snippet.description && wantsDetails) answer+='. תיאור: '+sanitizeForYemot(snippet.description).slice(0,900);
      if(/תגובות|מה אומרים בתגובות|מה כתבו בתגובות/i.test(question)) {
        const comments=await getYouTubeComments(target.videoId,wantsCommentDetails?15:8).catch(()=>[]);
        if(comments.length) {
          const digest=comments.map((x,i)=>{
            const text=sanitizeForYemot(x.textDisplay||x.textOriginal||'');
            const likes=Number(x.likeCount||0);
            const replies=Number(x.totalReplyCount||0);
            const meta=[
              likes>0 ? likes.toLocaleString('he-IL')+' לייקים' : '',
              replies>0 ? replies.toLocaleString('he-IL')+' תגובות המשך' : ''
            ].filter(Boolean).join(', ');
            return (i+1)+'. '+text+(meta?' ('+meta+')':'');
          }).join(' ');
          answer+= (wantsCommentDetails
            ? '. הנה פירוט רחב יותר של התגובות הבולטות, כולל לייקים ותגובות המשך: '
            : '. הנה כמה מהתגובות הבולטות: ') + digest;
        } else {
          answer+=' . לא הצלחתי לקבל את טקסט התגובות כרגע.';
        }
      }
      return answer+'.';
    } catch(e) {
      console.warn('[YouTube] statistics/comments unavailable',{message:String(e?.message||e).slice(0,500)});
      return 'מצאתי את הסרטון אבל נתוני הצפיות והתגובות אינם זמינים כרגע.';
    }
  }

  if(wantsContent) {
    const selected=videos[0];
    const videoUrl='https://www.youtube.com/watch?v='+selected.videoId;
    const title=sanitizeForYemot(selected.title||'הסרטון שנמצא');

    // Prefer an actual YouTube subtitle/auto-caption transcript so content
    // questions are answered from the video's spoken words, not its title.
    try {
      const transcriptData=await getYouTubeTranscript(selected.videoId);
      const transcriptText=String(transcriptData?.text||'').trim();
      if(transcriptText) {
        const prompt=`${EXCLUSIVE_INSTRUCTION}
השאלה של המתקשר: ${question}
זהו תמליל שהופק מהכתוביות/כתוביות האוטומטיות של סרטון YouTube:
${transcriptText.slice(0,50000)}

ענה בעברית, להקראה בטלפון, על בסיס התמליל בלבד.
אם נשאל "על מה דיברו" או "על מה הסרטון" — תן סיכום ברור ומפורט של הנושאים.
אם נשאל "מה בדיוק היה הדו-שיח" או שאלה דומה — תאר לפי סדר את עיקרי הדברים והטענות/השאלות והתשובות שנאמרו, בלי להמציא ובלי לטעון לציטוט מילה במילה אם התמליל אינו מלא.
אם מדובר בשיר — הסבר על מה השיר ומה המסר שלו לפי המילים הזמינות.
אם המידע בתמליל לא מספיק כדי לענות, אמור זאת במפורש.`;
        const result=await generateWithRetry([{role:'user',parts:[{text:prompt}]}],false,false);
        const answer=String(result?.response?.text?.()||'').trim();
        if(answer) return 'מצאתי את הסרטון '+title+'. '+sanitizeForYemot(answer);
      }
    } catch(e) {
      console.warn('[YouTube] transcript analysis unavailable', {
        videoId:selected.videoId,
        status:geminiErrorStatus(e),
        message:String(e?.message||'').slice(0,700)
      });
    }

    // Second fallback: direct public-video understanding by Gemini.
    try {
      const summary=await analyzePublicYouTubeVideo(videoUrl, question);
      if(summary && String(summary).trim())
        return 'מצאתי את הסרטון '+title+'. '+sanitizeForYemot(summary);
    } catch(e) {
      console.warn('[YouTube] video understanding unavailable', {status:geminiErrorStatus(e),message:String(e?.message||'').slice(0,500)});
    }

    return 'מצאתי את הסרטון '+title+' אבל לא הצלחתי כרגע לקבל תמליל או ניתוח אמין של התוכן.';
  }

  const list=videos.slice(0,wantsNewest?9:15);
  const spoken=list.map((x,i)=>{
    const date=x.publishedAt?new Intl.DateTimeFormat('he-IL',{timeZone:'Asia/Jerusalem',year:'numeric',month:'long',day:'numeric'}).format(new Date(x.publishedAt)):'תאריך לא זמין';
    return 'תוצאה '+(i+1)+': '+sanitizeForYemot(x.title||'ללא כותרת')+'. הערוץ: '+sanitizeForYemot(x.channelTitle||'לא ידוע')+'. פורסם בתאריך '+date+'.';
  }).join(' ');

  if(wantsNewest) {
    const newest=list[0];
    return 'הסרטון החדש ביותר שמצאתי הוא '+sanitizeForYemot(newest.title||'ללא כותרת')+
      ', בערוץ '+sanitizeForYemot(newest.channelTitle||'לא ידוע')+
      '. הוא פורסם בתאריך '+(newest.publishedAt?new Intl.DateTimeFormat('he-IL',{timeZone:'Asia/Jerusalem',dateStyle:'full'}).format(new Date(newest.publishedAt)):'תאריך לא זמין')+
      '. אם תרצה, שאל אותי על מה הסרטון ואני אנסה לנתח את התוכן שלו.';
  }

  return 'מצאתי ביוטיוב את התוצאות הבאות. '+spoken+' כדי לבחור תוצאה, אמור את מספר התוצאה.';
}
async function getYouTubeStats(videoIds) {
  const key=String(process.env.YOUTUBE_API_KEY||'').trim();
  const ids=[...new Set((videoIds||[]).filter(Boolean))].slice(0,50);
  if(!key || !ids.length) return new Map();
  const url=new URL('https://www.googleapis.com/youtube/v3/videos');
  url.searchParams.set('part','snippet,statistics,contentDetails,liveStreamingDetails');
  url.searchParams.set('id',ids.join(','));
  url.searchParams.set('key',key);
  const response=await withTimeout(fetch(url),REQUEST_TIMEOUT_MS,'YouTube video statistics');
  const data=await response.json();
  if(!response.ok) throw Object.assign(new Error('YouTube statistics HTTP '+response.status),{status:response.status});
  return new Map((data.items||[]).map(v=>[v.id,v]));
}

async function getYouTubeComments(videoId, maxResults=10) {
  const key=String(process.env.YOUTUBE_API_KEY||'').trim();
  if(!key || !videoId) return [];
  const url=new URL('https://www.googleapis.com/youtube/v3/commentThreads');
  url.searchParams.set('part','snippet');
  url.searchParams.set('videoId',videoId);
  url.searchParams.set('maxResults',String(Math.min(100,Math.max(1,maxResults))));
  url.searchParams.set('order','relevance');
  url.searchParams.set('textFormat','plainText');
  url.searchParams.set('key',key);
  const response=await withTimeout(fetch(url),REQUEST_TIMEOUT_MS,'YouTube comments');
  const data=await response.json();
  if(!response.ok) throw Object.assign(new Error('YouTube comments HTTP '+response.status),{status:response.status});
  return (data.items||[]).map(x=>{
    const s=x.snippet?.topLevelComment?.snippet;
    if(!s) return null;
    return {
      ...s,
      totalReplyCount:Number(x.snippet?.totalReplyCount||0)
    };
  }).filter(Boolean);
}


function isTransitRequest(text) {
  return /(אוטובוס|אוטובוסים|תחבורה ציבורית|רכבת|תחנת רכבת|מסלול נסיעה|איך מגיעים|איך להגיע|קו\\s*\\d+)/i.test(String(text||''));
}

function extractTransitEndpoints(question) {
  const q=String(question||'').replace(/\\s+/g,' ').trim();
  const patterns=[
    /(?:מ|מן)\\s+(.+?)\\s+(?:ל|אל)\\s+(.+?)(?:\\s+(?:עכשיו|היום|מחר|ב\\s+\\d{1,2}[:.]\\d{2}|\\?|$))/i,
    /(?:מוצא)\\s*[:]?\\s*(.+?)\\s+(?:יעד|ל)\\s*[:]?\\s*(.+?)(?:\\s+|$)/i
  ];
  for(const re of patterns){
    const m=q.match(re);
    if(m && m[1] && m[2]) return {origin:m[1].trim(),destination:m[2].trim()};
  }
  return null;
}

async function answerTransitDirect(question) {
  const key=(process.env.GOOGLE_MAPS_API_KEY||'').trim();
  const endpoints=extractTransitEndpoints(question);
  if(!key || !endpoints) return null;
  const now=new Date();
  const body={
    origin:{address:endpoints.origin},
    destination:{address:endpoints.destination},
    travelMode:'TRANSIT',
    departureTime:now.toISOString(),
    languageCode:'he-IL',
    units:'METRIC'
  };
  const response=await withTimeout(fetch('https://routes.googleapis.com/directions/v2:computeRoutes',{
    method:'POST',
    headers:{'Content-Type':'application/json','X-Goog-Api-Key':key,
      'X-Goog-FieldMask':'routes.duration,routes.distanceMeters,routes.legs.steps.transitDetails,routes.legs.steps.navigationInstruction,routes.localizedValues,routes.travelAdvisory.transitFare'},
    body:JSON.stringify(body)
  }),REQUEST_TIMEOUT_MS,'Google transit route');
  const data=await response.json().catch(()=>({}));
  if(!response.ok) throw Object.assign(new Error(data?.error?.message||'Google transit route HTTP '+response.status),{status:response.status});
  const route=data?.routes?.[0];
  if(!route) return null;
  const steps=(route.legs||[]).flatMap(leg=>leg.steps||[]);
  const transitSteps=steps.map(step=>step.transitDetails).filter(Boolean);
  const lines=[];
  for(const step of transitSteps){
    const line=step.transitLine||{};
    const name=line.name||line.shortName||'';
    const from=step.stopDetails?.departureStop?.name||'';
    const to=step.stopDetails?.arrivalStop?.name||'';
    if(name) lines.push((line.agency?.[0]?.name?line.agency[0].name+' ':'')+'קו '+name+(from?' מהתחנה '+from:'')+(to?' לתחנה '+to:''));
  }
  const duration=route.localizedValues?.duration?.text || (route.duration ? Math.round(parseFloat(route.duration)/60)+' דקות' : '');
  let answer='מסלול התחבורה הציבורית שמצאתי עכשיו מ'+endpoints.origin+' ל'+endpoints.destination;
  if(duration) answer+=' נמשך בערך '+duration;
  if(lines.length) answer+=' וכולל '+lines.slice(0,4).join(', ')+'.';
  else answer+='.';
  const fare=route.travelAdvisory?.transitFare?.localized?.text || route.travelAdvisory?.transitFare?.currency?.units;
  if(fare) answer+=' התעריף המשוער הוא '+fare+'.';
  answer+=' הנתונים מבוססים על נתיב תחבורה שנבדק בזמן הבקשה.';
  return sanitizeForYemot(answer);
}

function isPharmacySearchRequest(transcript) {
  const t=String(transcript||'').toLowerCase().replace(/\s+/g,' ').trim();
  return /(בית מרקחת|בתי מרקחת|סופר.?פארם|פארם)/i.test(t) &&
    /(פתוח עכשיו|פתוח היום|פתוחה עכשיו|פתוחה היום|מתי פתוח|מתי נסגר|מתי סוגר|אחד.*טובים|מומלץ|הכי טוב|טוב בבית שמש)/i.test(t);
}

function extractSearchCity(transcript) {
  const t=String(transcript||'').replace(/\s+/g,' ').trim();
  const cities=['בית שמש','ירושלים','רעננה','ביתר עילית','בני ברק','פתח תקווה','תל אביב','חיפה','אשדוד','נתניה','רחובות','מודיעין','באר שבע'];
  return cities.find(city=>t.includes(city)) || '';
}

async function answerPharmacySearchDirect(transcript) {
  const question=String(transcript||'').trim();
  const loc=extractExplicitLocation(question);
  const city=loc.city || extractSearchCity(question) || 'בית שמש';
  const area=loc.area || '';
  const locationText=[area,city].filter(Boolean).join(' ');
  const queries=[
    'בית מרקחת '+locationText+' פתוח עכשיו',
    'בית מרקחת כללית דונה '+locationText+' שעות פתיחה',
    'כללית '+locationText+' בית מרקחת שעות פתיחה אתר רשמי',
    'בית מרקחת '+locationText+' כתובת טלפון שעות פתיחה אתר רשמי'
  ];
  const settled=await Promise.allSettled(queries.map(q=>searchWebDirect(q,{timeoutMs:4500})));
  const all=[];
  for(const item of settled) if(item.status==='fulfilled') all.push(...item.value);
  const unique=dedupeSearchResults(all).slice(0,12);
  if(!unique.length) throw Object.assign(new Error('Pharmacy search returned no results'),{status:503});
  const evidence=unique.map((x,i)=>
    'מקור '+(i+1)+': '+x.title+'\nכתובת: '+x.url+'\nמידע: '+String(x.snippet||'').slice(0,1400)
  ).join('\n\n');
  const prompt='השאלה של המתקשר: '+question+'\nהעיר: '+city+'\nמקורות אינטרנט שנאספו עכשיו:\n'+evidence+'\n\n'+
    'ענה ישירות על השאלה. אם המתקשר שאל איזה בית מרקחת פתוח עכשיו או ביקש אחד מבתי המרקחת הטובים, תן קודם שם של אפשרות אחת טובה ורלוונטית שפתוחה עכשיו, ואז כתובת ושעת סגירה אם הן מאומתות. אפשר להוסיף אפשרות נוספת אחת בלבד אם היא מועילה. '+
    'אל תקריא את פעולת החיפוש ואל תגיד "מצאתי מידע". אל תקריא רשימת תוצאות. העדף מקור רשמי או מקור מקומי עדכני. '+
    'אם אין דרך לאמת שהמקום פתוח עכשיו, אמור זאת במפורש ואל תנחש. התשובה קצרה, ממוקדת וטבעית להקראה בטלפון.';
  try {
    const result=await generateBranch1WithFallback([{role:'user',parts:[{text:EXCLUSIVE_INSTRUCTION+'\n\n'+prompt}]}],false,true);
    const answer=String(result?.response?.text?.()||'').trim();
    if(answer) return answer;
  } catch(e) {
    console.warn('[PHARMACY_SEARCH] synthesis unavailable',{status:geminiErrorStatus(e)});
  }
  const first=unique[0];
  return sanitizeForYemot((first.title+'. '+String(first.snippet||'')).trim());
}

function isLongAnswerRequest(text) {
  const q=String(text||'').toLowerCase().replace(/\\s+/g,' ').trim();
  return /(תשובה ארוכה|תשובה מפורטת|בהרחבה|בפירוט|תפרט|פרט|ספר לי סיפור|סיפור ארוך|כמה דקות|מספר דקות|מאמר|סקירה מקיפה|היסטוריה של|הסיפור המלא|תן את כל הפרטים|כל הפרטים|לעומק)/i.test(q) || q.length>320;
}

function shouldForceWebSearch(transcript) {
  const t = String(transcript || '').toLowerCase().replace(/\s+/g,' ').trim();
  // Explicit search language always means live web search, even when the topic
  // is something the server did not anticipate in a hard-coded category list.
  if (/(חפש|תחפש|תמצא|תאתר|בדוק|תבדוק|תברר|בירור|חיפוש|חפש לי|תבדוק לי|תמצא לי|באינטרנט|בגוגל|ברשת|באתר|באתרים|מה כתוב באתר|מה כתבו על|מצא לי מידע|תן לי מידע עדכני)/i.test(t)) return true;
  return /(חדשות|מבזק|אקטואלי|היום|עכשיו|כרגע|השידור החי|שידור חי|מתי מתחיל|מתי מתחילה|מתי מתחילים|על מה דיברו|מה דיברו|מה אמרו|מה היה בתוכנית|לוח שידורים|תוכנית היום|מספר טלפון|טלפון|כתובת|שעות פתיחה|שעות פעילות|פתוח עכשיו|סגור היום|מתי נסגר|מתי סוגר|מתי פתוח|יצירת קשר|איך יוצרים קשר|אתר רשמי|רשתות חברתיות|רשת חברתית|אינסטגרם|פייסבוק|טיקטוק|טוויטר|עדכון אחרון|מה חדש|הופעה|הופעות|מופע|מופעים|אירוע|אירועים|כרטיסים|רכישת כרטיסים|לקנות כרטיסים|איפה קונים|מחיר כרטיס|מכירת כרטיסים|בית מרקחת|בתי מרקחת|חנות|חנויות|עסק|עסקים|סניף|סניפים|כתובת של|מייל של|דוא.?ל|אימייל|קישור|האתר של|מידע מהאתר|חפש באתר|תחפש באתר|המונדיאל|גביע העולם|מי ניצח|מי זכה|תוצאה|משחק|אליפות העולם|אוטובוס|אוטובוסים|תחנת אוטובוס|תחבורה ציבורית|קו אוטובוס|קווי אוטובוס|רכבת|תחנת רכבת|מסלול נסיעה|איך מגיעים|איך להגיע|הגעה ל|טיול|טיולים|מסלול טיול|אירוע היום|אירועים היום|פעילות היום|פעילויות היום|פעילות קהילתית|פעילויות קהילתיות|מה יש היום|מה יש בסוף השבוע|מה יש בעיר)/i.test(t);
}

function parseJinaSearchResults(body){
  const source=String(body||'').trim();
  if(!source) return [];
  let parsed=null;
  try{ parsed=JSON.parse(source); }catch{}
  const entries=Array.isArray(parsed)?parsed:(Array.isArray(parsed?.data)?parsed.data:(Array.isArray(parsed?.results)?parsed.results:(Array.isArray(parsed?.items)?parsed.items:[])));
  const results=[];
  for(const item of entries.slice(0,10)){
    const title=stripHtml(decodeHtmlEntities(String(item?.title||item?.name||'').trim()));
    const url=normalizeSearchHref(String(item?.url||item?.link||'').trim());
    const snippet=stripHtml(decodeHtmlEntities(String(item?.content||item?.snippet||item?.description||'').replaceAll('\n',' ').replaceAll('\r',' ').replaceAll('\t',' ').trim())).slice(0,1800);
    if(title&&url) results.push({title,url,snippet});
  }
  return dedupeSearchResults(results);
}

function parseJinaMarkdownResults(markdown){
  const results=[];
  const source=String(markdown||'');
  let cursor=0;
  while(results.length<10){
    const open=source.indexOf('[',cursor);
    if(open<0) break;
    const close=source.indexOf('](',open+1);
    if(close<0) break;
    const finish=source.indexOf(')',close+2);
    if(finish<0) break;
    const title=stripHtml(decodeHtmlEntities(source.slice(open+1,close).trim()));
    const url=normalizeSearchHref(source.slice(close+2,finish).trim());
    if(title&&url&&!url.includes('jina.ai')) results.push({title,url,snippet:''});
    cursor=finish+1;
  }
  return dedupeSearchResults(results);
}
async function searchWebDirect(query, options={}) {
  const q=String(query||'').trim();
  if(!q) return [];
  const timeoutMs=Number(options.timeoutMs||DIRECT_WEB_QUERY_TIMEOUT_MS);
  const googleUrl='https://www.google.com/search?gbv=1&hl=he&gl=il&num=10&q='+encodeURIComponent(q.slice(0,240));
  const providers=[
    ['jina-search','https://s.jina.ai/?q='+encodeURIComponent(q.slice(0,240)),parseJinaSearchResults],
    ['jina-google','https://r.jina.ai/'+googleUrl,parseJinaSearchResults],
    ['bing-rss','https://www.bing.com/search?format=rss&q='+encodeURIComponent(q.slice(0,240)),parseBingRssResults],
    ['google',googleUrl,parseGoogleResults],
    ['yahoo','https://search.yahoo.com/search?p='+encodeURIComponent(q.slice(0,240)),parseYahooResults],
    ['duckduckgo','https://html.duckduckgo.com/html/?q='+encodeURIComponent(q.slice(0,240)),parseDuckDuckGoResults]
  ];
  let lastError=null;
  const attempts=providers.map(async provider=>{
    const name=provider[0], target=provider[1], parser=provider[2];
    const response=await withTimeout(fetch(target,{headers:{
      'user-agent':'Mozilla/5.0 (compatible; YemotAI/1.0)',
      'accept':'application/json,text/plain,application/rss+xml,application/xml,text/html;q=0.9,*/*;q=0.8',
      'accept-language':'he-IL,he;q=0.9,en;q=0.7'
    }}),timeoutMs,'direct web search '+name);
    const raw=await response.text();
    if(!response.ok) throw Object.assign(new Error('Direct web search '+name+' HTTP '+response.status),{status:response.status});
    const parsed=parser(raw).filter(x=>x.title&&x.url);
    if(!parsed.length) throw Object.assign(new Error('Direct web search '+name+' returned no parsed results'),{status:502});
    console.info('[DIRECT_WEB] provider succeeded',{provider:name,query:q.slice(0,180),results:parsed.length});
    return parsed.slice(0,10);
  });
  const settled=await Promise.allSettled(attempts);
  const successful=settled.filter(x=>x.status==='fulfilled').flatMap(x=>x.value||[]);
  const merged=dedupeSearchResults(successful).slice(0,20);
  if(merged.length) return merged;
  for(const item of settled.filter(x=>x.status==='rejected')) {
    const err=item.reason;
    console.warn('[DIRECT_WEB] parallel provider failed',{status:geminiErrorStatus(err),message:String(err?.message||err).slice(0,220)});
  }
  throw Object.assign(new Error('Direct web search unavailable'),{status:503});
}

function decodeXml(value){
  return decodeHtmlEntities(String(value||'').replace('<![CDATA[','').replace(']]>',''));
}

function xmlTagValue(block,tag){
  const startTag='<'+tag;
  const start=block.indexOf(startTag);
  if(start<0) return '';
  const contentStart=block.indexOf('>',start);
  if(contentStart<0) return '';
  const end=block.indexOf('</'+tag+'>',contentStart+1);
  if(end<0) return '';
  return decodeXml(block.slice(contentStart+1,end));
}

function parseBingRssResults(xml){
  const results=[];
  const parts=String(xml||'').split('<item>').slice(1,16);
  for(const item of parts){
    const title=stripHtml(xmlTagValue(item,'title'));
    const url=normalizeSearchHref(xmlTagValue(item,'link'));
    const snippet=stripHtml(xmlTagValue(item,'description'));
    if(title&&url) results.push({title,url,snippet});
  }
  return dedupeSearchResults(results);
}

function normalizeSearchHref(rawHref){
  let href=decodeHtmlEntities(String(rawHref||'').trim());
  if(!href) return '';
  try{
    if(href.startsWith('//')) href='https:'+href;
    if(href.startsWith('/url?')||href.startsWith('/url/')){
      const u=new URL('https://www.google.com'+href);
      href=u.searchParams.get('q')||u.searchParams.get('url')||href;
    }
    if(!href.startsWith('http://')&&!href.startsWith('https://')) return '';
    const u=new URL(href);
    for(const key of ['url','u','target']){
      const nested=u.searchParams.get(key);
      if(nested&&(nested.startsWith('http://')||nested.startsWith('https://'))){ href=nested; break; }
    }
    return href;
  }catch{return '';}
}

function parseHeadingResults(html,headingTag){
  const results=[];
  const source=String(html||'');
  const open='<'+headingTag;
  const close='</'+headingTag+'>';
  let cursor=0;
  while(results.length<15){
    const start=source.indexOf(open,cursor);
    if(start<0) break;
    const contentStart=source.indexOf('>',start);
    if(contentStart<0) break;
    const end=source.indexOf(close,contentStart+1);
    if(end<0) break;
    const title=stripHtml(decodeHtmlEntities(source.slice(contentStart+1,end)));
    const before=source.slice(Math.max(0,start-6000),start);
    let href='';
    let linkCursor=0;
    while(true){
      const a=before.indexOf('<a',linkCursor);
      if(a<0) break;
      const h=before.indexOf('href=',a);
      if(h<0) break;
      const quote=before.charAt(h+5);
      const valueStart=h+6;
      const valueEnd=before.indexOf(quote,valueStart);
      if(valueEnd<0) break;
      const candidate=normalizeSearchHref(before.slice(valueStart,valueEnd));
      if(candidate&&!candidate.includes('google.')&&!candidate.includes('bing.')&&!candidate.includes('yahoo.')) href=candidate;
      linkCursor=a+2;
    }
    if(title&&href) results.push({title,url:href,snippet:''});
    cursor=end+close.length;
  }
  return dedupeSearchResults(results);
}

function parseGoogleResults(html){ return parseHeadingResults(html,'h3'); }
function parseYahooResults(html){ return parseHeadingResults(html,'h3'); }

function parseDuckDuckGoResults(html){
  const results=[];
  const source=String(html||'');
  const blocks=source.split('result__a');
  for(let i=1;i<blocks.length&&results.length<15;i++){
    const block=blocks[i];
    const quote=block.indexOf('href=');
    if(quote<0) continue;
    const qchar=block.charAt(quote+5);
    const start=quote+6;
    const end=block.indexOf(qchar,start);
    if(end<0) continue;
    const href=normalizeSearchHref(block.slice(start,end));
    const gt=block.indexOf('>',end);
    const titleEnd=block.indexOf('</a>',gt);
    const title=gt>=0&&titleEnd>gt?stripHtml(decodeHtmlEntities(block.slice(gt+1,titleEnd))):'';
    if(title&&href) results.push({title,url:href,snippet:''});
  }
  return dedupeSearchResults(results);
}

function dedupeSearchResults(results){
  const seen=new Set();
  return results.filter(x=>{
    const key=String(x.url||'').replace(/[?#].*$/,'').toLowerCase();
    if(!key||seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function stripHtml(value){
  return String(value||'').replace(/<script[\s\S]*?<\/script>/gi,' ')
    .replace(/<style[\s\S]*?<\/style>/gi,' ')
    .replace(/<[^>]+>/g,' ')
    .replace(/&nbsp;/gi,' ')
    .replace(/\s+/g,' ').trim();
}
function decodeHtmlEntities(value){
  return String(value||'')
    .replace(/&amp;/gi,'&').replace(/&quot;/gi,'"').replace(/&#39;|&apos;/gi,"'")
    .replace(/&lt;/gi,'<').replace(/&gt;/gi,'>')
    .replace(/&#x2F;/gi,'/').replace(/&#x27;/gi,"'");
}
function extractLocalArea(question){
  const t=String(question||'').replace(/\s+/g,' ').trim();
  const areas=['רמה א','רמה א׳','רמה ב','רמה ב׳','רמה ג','רמה ג׳','רמה ד','רמה ד׳','רמה ה','רמה ה׳','רמת בית שמש','מרכז העיר','מגדל המים','נחם','גבעת שרת','גבעת משקף','נווה שמיר','המשקפיים','הקניון','ביג'];
  return areas.find(x=>t.includes(x)) || '';
}
function extractExplicitLocation(question){
  const t=String(question||'').replace(/\s+/g,' ').trim();
  const cityMatch=t.match(/(?:ב|ל|מ|אזור)\s+(בית שמש|ירושלים|רעננה|ביתר עילית|בני ברק|פתח תקווה|תל אביב|חיפה|אשדוד|נתניה|רחובות|מודיעין|באר שבע)/i);
  const city=cityMatch?cityMatch[1]:'';
  const area=extractLocalArea(t);
  return {city,area};
}
function isPhoneNumberRequest(question){
  return /(מספר טלפון|טלפון|טלפון של|מספר של|מה המספר|איך מתקשרים|מוקד|שירות לקוחות)/i.test(String(question||''));
}
function isBusinessLocalRequest(question){
  return /(בית מרקחת|בתי מרקחת|סופר.?פארם|חנות|חנויות|עסק|עסקים|סניף|סניפים|מסעדה|מסעדות|בנק|בנקאות|קופת חולים|מרפאה|מרפאות)/i.test(String(question||''));
}
function mapsIsraelUrl(title,address){
  const q=[title,address].filter(Boolean).join(', ');
  return q ? 'https://www.google.com/maps/search/?api=1&query='+encodeURIComponent(q) : '';
}

function officialDomainsForQuestion(question){
  const q=String(question||'').toLowerCase();
  const map=[
    [/דיסקונט|discount/,['discountbank.co.il']],
    [/כללית|clalit/,['clalit.co.il']],
    [/מכבי|maccabi/,['maccabi4u.co.il']],
    [/מאוחדת|meuhedet/,['meuhedet.co.il']],
    [/לאומית|leumit/,['leumit.co.il']],
    [/סופר.?פארם|super.?pharm/,['super-pharm.co.il']],
    [/בנק הפועלים|הפועלים|poalim/,['bankhapoalim.co.il']],
    [/לאומי|בנק לאומי|leumi/,['leumi.co.il']],
    [/מזרחי|מזרחי טפחות|mizrahi/,['mizrahitefahot.co.il']]
  ];
  for(const [pattern,domains] of map) if(pattern.test(q)) return domains;
  return [];
}
function isOfficialSearchUrl(url,domains){
  try{
    const host=new URL(String(url||'')).hostname.toLowerCase().replace(/^www\./,'');
    return domains.some(d=>host===d || host.endsWith('.'+d));
  }catch{return false;}
}
function normalizePhoneCandidate(value){
  let s=String(value||'').replace(/[״"׳']/g,'').trim();
  if(!s) return '';
  let m=s.match(/\*\s*(\d{3,6})/);
  if(m) return '*'+m[1];
  m=s.match(/(^|\s)(\d{3,6})\s*\*(?=\s|$)/);
  if(m) return '*'+m[2];
  return '';
}
function extractStarPhoneCandidates(text){
  const out=[];
  for(const re of [/\*\s*\d{3,6}/g,/\b\d{3,6}\s*\*/g]){
    for(const match of String(text||'').matchAll(re)){
      const n=normalizePhoneCandidate(match[0]);
      if(n&&!out.includes(n)) out.push(n);
    }
  }
  return out;
}

// Verified primary star numbers for entities whose official contact pages clearly
// identify a primary public hotline. These are NOT used blindly: answerPhoneNumberDirect
// still requires live official-source corroboration before returning them.
const VERIFIED_PRIMARY_STAR_NUMBERS = [
  { test: /דיסקונט|discount/i, number: '*6111', domain: 'discountbank.co.il' }
];

function requestedPrimaryStarNumber(question){
  const q=String(question||'');
  const hit=VERIFIED_PRIMARY_STAR_NUMBERS.find(x=>x.test.test(q));
  return hit || null;
}

function phoneEntityLabel(question){
  const q=String(question||'').replace(/^.*?(?:מספר|טלפון|מוקד|שירות לקוחות)\s*(?:של|ה)?\s*/i,'').trim();
  return q.replace(/(?:שמתחיל.*|שמתחילה.*|בכוכבית.*|בכוכב.*)$/i,'').trim();
}
async function answerPhoneNumberDirect(question){
  const domains=officialDomainsForQuestion(question);
  const base=String(question||'').replace(/^.*?(?:חפש|תחפש|בדוק|תבדוק)\s*(?:לי\s*)?(?:באינטרנט\s*)?/i,'').trim();
  const isStarRequest=/כוכבית|כוכב|\*\s*\d/i.test(String(question||''));
  const preferred=requestedPrimaryStarNumber(question);
  const queries=[
    base+' מספר טלפון',
    base+' מוקד טלפון',
    ...(domains.length ? domains.map(d=>base+' site:'+d+' טלפון') : [base+' אתר רשמי טלפון'])
  ];
  const settled=await Promise.allSettled(queries.slice(0,4).map(q=>searchWebDirect(q,{timeoutMs:4500})));
  const all=[];
  for(const item of settled) if(item.status==='fulfilled') all.push(...item.value);
  const unique=dedupeSearchResults(all);
  if(!unique.length) throw Object.assign(new Error('Phone verification returned no results'),{status:503});

  const official=unique.filter(x=>isOfficialSearchUrl(x.url,domains));
  if(domains.length && !official.length){
    throw Object.assign(new Error('No official source available for phone verification'),{status:422});
  }
  const pool=official.length ? official : unique;

  const sourceNumbers=new Map();
  for(const item of pool){
    const text=[item.title,item.snippet].join(' ');
    const stars=extractStarPhoneCandidates(text);
    const regular=text.match(/(?:0\d(?:[-\s]?\d){7,9})/g)||[];
    for(const n of [...stars,...regular.map(n=>n.replace(/\s+/g,' '))]){
      const key=n.replace(/[\s-]/g,'');
      if(!sourceNumbers.has(key)) sourceNumbers.set(key,{display:n,sources:[]});
      sourceNumbers.get(key).sources.push(item.url);
    }
  }
  const independentlyVerified=[...sourceNumbers.values()]
    .filter(x=>new Set(x.sources).size>=2);

  if(isStarRequest){
    if(preferred){
      const preferredKey=preferred.number.replace(/[\s-]/g,'');
      const hit=independentlyVerified.find(x=>x.display.replace(/[\s-]/g,'')===preferredKey);
      if(hit) return 'המספר שביקשת הוא '+preferred.number+'.';
    }
    if(independentlyVerified.length===1){
      return 'המספר שביקשת הוא '+independentlyVerified[0].display+'.';
    }
    throw Object.assign(new Error('Unverified star phone number'),{status:422});
  }

  if(independentlyVerified.length===1){
    return 'מספר הטלפון הוא '+independentlyVerified[0].display+'.';
  }
  throw Object.assign(new Error('Unverified phone number'),{status:422});
}

function extractDirectSearchQueries(question){
  const cleaned=String(question||'').trim().replace(/^(?:אז\s+)?(?:תחפש|חפש|בדוק|תבדוק|תמצא|תאתר|תברר)(?:\s+לי)?(?:\s+באינטרנט|\s+ברשת|\s+בגוגל)?\s*/i,'').trim();
  const loc=extractExplicitLocation(cleaned);
  const queries=[];
  const locationTail=[loc.area,loc.city].filter(Boolean).join(' ');
  const base=locationTail && !cleaned.includes(locationTail) ? cleaned+' '+locationTail : cleaned;
  queries.push(base);
  if(isPhoneNumberRequest(cleaned)){
    queries.push(base+' מספר טלפון מוקד שירות לקוחות');
    queries.push(base+' אתר רשמי טלפון');
    for(const d of officialDomainsForQuestion(cleaned)) queries.push(base+' site:'+d+' טלפון');
  } else if(isBusinessLocalRequest(cleaned)){
    queries.push(base+' כתובת מדויקת שעות פתיחה טלפון');
    queries.push(base+' אתר רשמי סניפים');
    queries.push(base+' מפה Google Maps');
  } else if(/אוטובוס|אוטובוסים|רכבת|תחבורה ציבורית|קו\s*\d+/i.test(cleaned)){
    queries.push(base+' לוח זמנים');
    queries.push(base+' מסלול תחנות');
  } else if(/הופעה|הופעות|אירוע|אירועים|כרטיסים|מופע|מופעים/i.test(cleaned)){
    queries.push(base+' תאריך שעה מחיר כרטיסים');
    queries.push(base+' אתר רשמי');
  } else {
    queries.push(base+' מידע עדכני');
    queries.push(base+' מקור רשמי');
  }
  return [...new Set(queries.filter(Boolean).map(x=>x.slice(0,240)))].slice(0,5);
}
async function answerWithDirectWebFallback(question){
  const queries=extractDirectSearchQueries(question);
  const settled=await Promise.allSettled(queries.map(q=>searchWebDirect(q,{timeoutMs:DIRECT_WEB_QUERY_TIMEOUT_MS})));
  const all=[];
  for(let i=0;i<settled.length;i++){
    const item=settled[i];
    if(item.status==='fulfilled') all.push(...item.value);
    else console.warn('[DIRECT_WEB] search query failed',{query:queries[i],status:geminiErrorStatus(item.reason),message:String(item.reason?.message||item.reason).slice(0,300)});
  }
  const seen=new Set();
  const unique=all.filter(x=>{
    const key=String(x.url||x.title).replace(/[?#].*$/,'').toLowerCase();
    if(seen.has(key)) return false;
    seen.add(key); return true;
  }).slice(0,12);
  if(!unique.length) throw Object.assign(new Error('Direct web search returned no results'),{status:503});

  // The direct provider is a retrieval layer, not the final answer. When Gemini
  // Search grounding is unavailable, first try to let the normal Gemini answer
  // model synthesize the collected evidence. This prevents the phone line from
  // reading raw search-result snippets back to the caller.
  const evidence=unique.map((x,i)=>{
    const snippet=String(x.snippet||'').trim();
    const map=mapsIsraelUrl(x.title||'',snippet);
    return 'מקור '+(i+1)+': '+String(x.title||'')+'\nכתובת מקור: '+String(x.url||'')+'\nקישור מפה אפשרי: '+map+'\nתוכן: '+snippet.slice(0,1800);
  }).join('\n\n');
  const synthesisPrompt=
    'אתה מנוע תשובות קולי חכם. נסח תשובה ישירה לשאלה של המתקשר על בסיס מקורות האינטרנט שנאספו בלבד.\\n'+
    'השאלה: '+question+'\\n\\n'+
    'מקורות שנאספו:\\n'+evidence+'\\n\\n'+
    'כללי תשובה: התחל בתשובה עצמה, לא במשפט כמו "מצאתי מידע". חבר בין המקורות ואל תקריא רשימת תוצאות חיפוש. '+
    'אם מדובר בעסק או שירות מקומי, התייחס קודם למיקום שהמשתמש ציין, כולל שכונה/רמה/אזור, וחפש את האפשרויות הקרובות והרלוונטיות ביותר. '+
    'לכל מקום שמומלץ לציין, תן שם מלא, כתובת מלאה, טלפון ושעות פעילות אם נמצאו. אם המשתמש ביקש מיקום, צור גם קישור Google Maps מתאים על בסיס שם המקום והכתובת; אל תמציא קואורדינטות. '+
    'אם המשתמש ביקש מספר טלפון, אל תקריא מספר שמופיע רק במקור אחד לא מזוהה. העדף אתר רשמי של העסק/הבנק/הארגון, ואם אין מקור רשמי אז אמת מול מקור נוסף ועקבי. '+
    'אם נמצאו מספרים סותרים, אל תבחר באקראי: ציין שיש סתירה וחפש מקור רשמי נוסף. עבור מספרי כוכבית, שמור בדיוק על הכוכבית והמיקום שלה, למשל *6111. '+
    'אם המשתמש ביקש כל הסניפים, אל תסתפק בסניף אחד. אם נתון לא אומת, אמור "לא הצלחתי לאמת" ולא תנחש. '+
    'אם יש סתירה בין מקורות, העדף מקור רשמי ועדכני. '+
    'דבר בעברית טבעית, זורמת ונעימה להקראה בטלפון. היה ממוקד אבל אל תשמיט פרט שהמשתמש ביקש במפורש. '+
    'אל תמציא עובדות שאינן במקורות.';
  try {
    const result=await generateBranch1WithFallback([{role:'user',parts:[{text:EXCLUSIVE_INSTRUCTION+'\\n\\n'+synthesisPrompt}]}],false,false);
    const answer=String(result?.response?.text?.()||'').trim();
    if(answer) return answer;
  } catch(e) {
    console.warn('[DIRECT_WEB] synthesis unavailable; returning structured evidence',{status:geminiErrorStatus(e)});
  }

  // Last-resort response: still structured and useful, without pretending that
  // snippets are a synthesized answer.
  return unique.slice(0,8).map((x,i)=>{
    const snippet=String(x.snippet||'').trim();
    return (i+1)+'. '+sanitizeForYemot(x.title)+(snippet ? '. '+sanitizeForYemot(snippet).slice(0,500) : '');
  }).join(' ');
}

async function answerWithWebSearch(transcript, historyText='') {
  const question=String(transcript||'').trim();
  if(!question) throw Object.assign(new Error('Search requested but transcript is empty'),{status:400});
  if(isPhoneNumberRequest(question)){
    try {
      return await answerPhoneNumberDirect(question);
    } catch(e) {
      console.warn('[PHONE_VERIFY] refusing to guess after verification failure',{status:geminiErrorStatus(e)});
      // A star-number request is never allowed to fall through to Gemini
      // synthesis: that could turn an unverified secondary number into a
      // confident but wrong answer.
      if(/כוכבית|כוכב|\*\s*\d/i.test(question)){
        return 'לא הצלחתי לאמת את מספר הכוכבית המדויק ממקור רשמי, ולכן אני לא רוצה לנחש.';
      }
      if(geminiErrorStatus(e)===422) return 'לא הצלחתי לאמת את המספר המדויק ממקור רשמי, ולכן אני לא רוצה לנחש.';
    }
  }
  if(isPharmacySearchRequest(question)) return await answerPharmacySearchDirect(question);
  try {
    const directAnswer=await answerWithDirectWebFallback(question);
    if(directAnswer && String(directAnswer).trim()) return String(directAnswer).trim();
  } catch(e) {
    console.warn('[WEB_SEARCH] direct retrieval first-pass failed; trying Gemini grounding',{status:geminiErrorStatus(e)});
  }
  if(!question) throw Object.assign(new Error('Search requested but transcript is empty'),{status:400});
  const prompt=`${EXCLUSIVE_INSTRUCTION}
הקשר קודם של השיחה:
${historyText || 'אין עדיין הקשר קודם.'}

השאלה המדויקת של המתקשר לחיפוש באינטרנט:
${question}

כאשר המתקשר אומר במפורש "חפש באינטרנט", "תחפש באינטרנט", "תעשה חיפוש", "תבדוק באינטרנט" או ניסוח דומה, הפעל מצב חיפוש עמוק ויסודי. מטרתך אינה לדווח שביצעת חיפוש אלא לתת למתקשר את התשובה הטובה ביותר שנבנתה מהחיפוש. חפש, אסוף, השווה, חבר והסק מסקנה רק מהעובדות שמצאת. אל תסתפק בחיפוש יחיד או בתוצאה הראשונה: פרק את השאלה לתת-שאלות וחפש כמה שאילתות ממוקדות ועצמאיות, בדרך כלל 3 עד 6 שאילתות כשיש מספיק חומר לכך. חפש גם בעברית וגם באנגלית כשזה עשוי לשפר את הכיסוי, חפש במקורות רשמיים/ראשוניים ובמקורות חדשותיים או מקצועיים אמינים, והשווה בין מקורות לפני המסקנה. אם מקור אחד סותר מקור אחר, בדוק מקור נוסף והסבר בקצרה את הסתירה במקום לבחור שרירותית. עבור מידע עדכני, העדף מקורות שפורסמו או עודכנו לאחרונה. אל תסתפק בתוצאה הראשונה ואל תמציא פרט שלא נמצא.

במצב חיפוש עמוק, קודם אסוף את העובדות הרלוונטיות מכל המקורות הזמינים ורק אחר כך נסח את התשובה. אם הבקשה רחבה, כסה את כל תתי-הנושאים שהמתקשר ביקש ולא רק את החלק הראשון שמצאת. אם הבקשה צריכה תשובה קצרה, בצע את החיפוש העמוק מאחורי הקלעים אבל הקרא רק את המסקנות החשובות. אם המתקשר מבקש "כל מידע שאצטרך", החזר תמונה מקיפה ומסודרת לפי נושאים, עם העובדות החשובות, תאריכים, מספרים, שמות ופרטים מעשיים שנמצאו. אם הוא מבקש "בקצרה", תן תקציר. אם הוא מבקש "בהרחבה", הרחב בהתאם.

עליך להשתמש בחיפוש אינטרנט חי כשזו שאלה על מידע עדכני, חדשות, תוצאות ספורט, מונדיאל או גביע העולם, לוחות שידורים, תוכניות, רשתות חברתיות, או אירועים שהתרחשו לאחרונה. השתמש בכלי Google Search המצורף וחפש לפי השאלה המדויקת. אל תענה מהזיכרון בלבד.
ענה בשפה שבה המתקשר דיבר, בתשובה ברורה ומפורטת שמתאימה להקראה בטלפון. אין לקצר מידע שהמשתמש ביקש במפורש.

חובה בעסקים ושירותים — פרוטוקול חיפוש מדויק:
1. אם המשתמש מבקש עסק, שירות, סניף, כתובת, טלפון או שעות פתיחה, אין להסתפק בתשובה כללית או בתוצאה אחת שנמצאה במקרה.
2. יש לפרק את הבקשה לנתונים הנדרשים: שם/סוג העסק, כל הסניפים הרלוונטיים לאזור שביקש, כתובת מלאה, טלפון ישיר, ושעות פעילות לכל יום בשבוע.
3. כאשר המשתמש מבקש "כל הסניפים", יש לבצע חיפוש שמטרתו לאתר את רשימת הסניפים לפני איסוף הפרטים. יש לבדוק כמה תוצאות ומקורות ולא לעצור בתוצאה הראשונה.
4. לכל סניף יש לאסוף בנפרד: שם הסניף, כתובת מלאה, טלפון, ושעות ראשון עד שבת ככל שהמקור מספק אותן. אם יום מסוים סגור — לציין "סגור"; אם פרט חסר — לציין "לא נמצא/לא אומת" ולא לנחש.
5. יש להעדיף מקור רשמי של העסק, ולאמת פרטים חשובים מול מקור נוסף ואמין כאשר אפשר. במקרה של סתירה, אין לבחור אוטומטית באחד מהם: לציין שיש סתירה ולהעדיף את המקור הרשמי או הנתון העדכני ביותר.
6. אין לכתוב "פתוח היום", "פתוח עד..." או ניסוח מקוצר במקום שעות שבועיות כאשר המשתמש ביקש שעות פתיחה. יש להציג את כל הימים במפורש.
7. אין להמציא סניפים, כתובות, טלפונים או שעות. אין להסיק פרט שלא נמצא במקור.
8. לאחר איסוף הנתונים, לבצע בדיקת שלמות פנימית: האם כל הסניפים שהתבקשו נמצאים, והאם לכל סניף יש את כל השדות שניתן היה לאמת.
9. אם אין אפשרות לאמת נתון מסוים מהרשת, לומר זאת במפורש ולהמשיך להציג את שאר הנתונים המאומתים.
10. התשובה הסופית צריכה להיות מחוברת ישירות לבקשה של המתקשר, מסודרת וברורה להקראה בטלפון, בלי להשמיט פרטים שביקש במפורש.

ענה בשפה שבה המתקשר דיבר, בסגנון שיחה טבעי, זורם, חכם ונעים. התשובה צריכה להרגיש כאילו עוזר אנושי חכם בדק את המידע וחיבר אותו עבורך. אל תפתח ב"מצאתי מידע", "בחיפוש מצאתי", "לפי תוצאות החיפוש" או ברשימת מקורות. התחל מיד בתשובה עצמה.
כאשר יש כמה מקורות, שלב אותם לתשובה אחת הגיונית: אל תקריא כותרות ותוצאות חיפוש בזו אחר זו. חלץ מכל מקור רק את העובדות הרלוונטיות, השווה ביניהן, הסר כפילויות, וסמן במפורש נתון שלא ניתן לאמת.
אם המשתמש ביקש כמה פרטים, החזר את כולם. אם הוא ביקש "כל הסניפים", הצג כל סניף בנפרד עם כל הפרטים שנמצאו. אם ביקש שעות, הצג את הימים והשעות ולא רק "פתוח היום". אם ביקש מספר טלפון או כתובת, אמור אותם במפורש.
אפשר להתחיל במשפט קצר שמסכם את התמונה, ואז לעבור לפרטים. לדוגמה: "כן, מצאתי כמה סניפים ברעננה. הנה הפרטים של כל אחד." לאחר מכן תן את המידע בפועל. אל תבזבז זמן על תיאור פעולת החיפוש.
אם נמצאו כמה אפשרויות טובות, הסבר בקצרה מה ההבדל ביניהן ומה הכי רלוונטי לבקשה. אם חסר נתון, אמור זאת בפשטות. לעולם אל תנחש.
אם המתקשר מבקש יצירת קשר עם אתר, חברה, גוף ציבורי, ערוץ, תוכנית או גורם תקשורתי, חפש פרטי קשר ציבוריים ורשמיים ככל שניתן, כולל אתר רשמי, טלפון, דוא"ל, כתובת עסקית וחשבונות רשתות חברתיות ציבוריים ורלוונטיים. אם מדובר באדם פרטי, אל תחשוף כתובת מגורים פרטית או פרטי קשר פרטיים; חפש רק פרטי קשר מקצועיים או ציבוריים שפורסמו רשמית. אל תמציא פרטי קשר.
אם המתקשר מבקש הופעות, מופעים, הצגות, הרצאות, פסטיבלים או אירועים בישראל או בעולם, חפש מידע עדכני ומקומי ככל שניתן והחזר את שם האירוע, האמן או המופע, העיר, המקום, התאריך והשעה, מחיר הכרטיס, קטגוריות/טווחי מחירים, קישור או מקור רכישה רשמי, אמצעי תשלום שמופיעים במקור, מדיניות ביטול/החזר אם זמינה, מגבלות גיל, נגישות, חניה ותחבורה אם רלוונטי. אם יש כמה תאריכים, ציין אותם בצורה מסודרת. אל תטען שכרטיסים זמינים אם המקור לא מציין זאת.
אם המתקשר מבקש שעות פתיחה של עסק, בית מרקחת, חנות, מרפאה או סניף, חפש את הסניף המדויק ולא רק את הרשת. בדוק את היום והתאריך הרלוונטיים ואת השעה המקומית הנוכחית כשצריך, והחזר שעות פתיחה וסגירה מדויקות, כולל הפסקות, ערב חג, חג ושינויים חריגים אם נמצאו. חפש גם טלפון ישיר, כתובת מלאה, אתר/עמוד סניף, ואם רלוונטי האם המקום מקבל קופה/ביטוח מסוים, מרשמים, הזמנות או איסוף. כשנשאל על תשלום, חפש במפורש אמצעי תשלום מקובלים כגון מזומן, אשראי, תשלום ללא מגע או תשלום מקוון, וכן עלויות, תנאים או מגבלות אם פורסמו. אם לא נמצא סניף מדויק, בקש עיר או כתובת.
אם המתקשר מבקש כתובות, מספרי טלפון, שעות פעילות או פרטי שירות של מקום מסוים, אל תיתן תשובה כללית על הרשת: זהה את המקום המדויק ואמת את הפרטים מול מקור רשמי או מקור מקומי אמין ככל האפשר.
אם השאלה על YouTube, סרטון או שיר, חפש לפי הנושא, הכותרת, הערוץ ותאריך הפרסום. כשנשאל 'הכי חדש' או 'האחרון', העדף תוצאת YouTube עם תאריך הפרסום העדכני ביותר שמתאימה לנושא. אם המתקשר שואל על תוכן הסרטון, השתמש רק בתמליל או בתוכן מלא שנגיש בפועל דרך מקור מותר; אם אין גישה לתוכן עצמו, אמור זאת במפורש והצע סיכום של המידע הזמין בלבד. לעולם אל תטען שצפית בסרטון או קראת תמליל אם לא נגישו.
אם המתקשר נותן כתובת אתר, שם דומיין או מבקש מידע מאתר מסוים, נסה לפתוח ולקרוא את המקור עצמו או לחפש בתוך האתר, ולא להסתפק בתוצאות כלליות. מותר להשתמש במידע ציבורי נגיש מהאתר גם אם הוא ארוך, ולסכם אותו לפי בקשת המתקשר. אל תטען שקראת עמוד אם הוא לא היה נגיש בפועל. אין לעקוף התחברות, CAPTCHA, חומת תשלום, הגבלת גישה או אמצעי אבטחה; במקרה כזה אמור שהחומר לא נגיש. המטרה היא חיפוש רחב ככל האפשר במקורות ציבוריים ונגישים.
אם החיפוש נכשל או לא החזיר מידע מספיק, אמור בקצרה שלא הצלחת להשיג מידע אמין כרגע. אל תציג כתובות אינטרנט ארוכות.`;
  try {
    const result=await generateBranch1WithFallback([{role:'user',parts:[{text:prompt}]}],true,false);
    const answer=result?.response?.text?.();
    if(answer && String(answer).trim()) return String(answer).trim();
    throw Object.assign(new Error('Web search returned an empty answer'),{status:503});
  } catch(e) {
    console.warn('[WEB_SEARCH] Gemini web grounding unavailable; using direct fallback', {
      status:geminiErrorStatus(e), message:String(e?.message||e).slice(0,500)
    });
    if(isWeatherQuestion(question)) return await answerWeatherDirect(question);
    if(isNewsQuestion(question)) return await answerNewsDirect(question, historyText);
    try {
      const directAnswer=await answerWithDirectWebFallback(question);
      console.info('[WEB_SEARCH] direct web fallback succeeded after Gemini failure');
      return directAnswer;
    } catch(fallbackError) {
      console.warn('[WEB_SEARCH] direct web fallback also failed',{status:geminiErrorStatus(fallbackError),message:String(fallbackError?.message||fallbackError).slice(0,400)});
    }
    throw e;
  }
}
async function buildOpeningForCaller(phone) {
  const key=normalizePhone(phone);
  const previous=conversationLog.filter(x=>normalizePhone(x.phone)===key).filter(x=>x.user && x.user!=='לא ניתן היה לתמלל את ההקלטה').slice(-6);
  if(!previous.length) return process.env.FIRST_CALL_MESSAGE || 'שלום, איזה כיף לשמוע אותך. אני כאן איתך. מה מתחשק לך לבדוק או לעשות עכשיו?';
  const recent=previous.slice().reverse();
  const topics=[];
  for(const item of recent) {
    const topic=sanitizeForYemot(String(item.user||'').replace(/\\s+/g,' ').trim().slice(0,180));
    if(!topic) continue;
    if(!topics.some(x=>x.toLowerCase()===topic.toLowerCase())) topics.push(topic);
    if(topics.length>=3) break;
  }
  const last=previous[previous.length-1];
  const lastAnswer=sanitizeForYemot(String(last && last.gemini || '').replace(/\\s+/g,' ').trim().slice(0,260));
  let opening='שלום שוב. איזה כיף לשמוע אותך.';
  if(topics.length===1) opening+=' בפעם האחרונה דיברנו על '+topics[0]+'.';
  else if(topics.length===2) opening+=' בפעם האחרונה דיברנו על '+topics[0]+', ולפני זה על '+topics[1]+'.';
  else if(topics.length>=3) opening+=' לאחרונה דיברנו על כמה דברים, בין השאר על '+topics[0]+', '+topics[1]+' וגם '+topics[2]+'.';
  if(lastAnswer) opening+=' עצרנו בערך כאן: '+lastAnswer+'.';
  opening+=' מה בא לך לעשות עכשיו? אפשר להמשיך בדיוק משם, או לפתוח נושא חדש.';
  return opening;
}
async function callHandler(call) {
  const callerPhone = getCallerNumber(call);
  const callId = call?.callId || call?.values?.ApiCallId || '';
  const activeKey = String(callId || (Date.now()+'-'+callerPhone));
  activeCalls.set(activeKey,{id:activeKey,phone:callerPhone,callId:String(callId||''),
    startedAt:new Date().toISOString(),status:'ממתין להקלטה'});
  let firstTurn=true;
  let openingPrompt=null;
  let nextPrompt=null;
  let emptyRecordAttempts=0;
  let feedbackPending=false;
  const turnHistory=[];
  const turnContext={youtubeResults:[]};
  if (process.env.ENABLE_AI_OPENING !== 'false' && callerPhone !== 'לא מזוהה' && conversationLog.some(x=>x.phone===callerPhone)) {
    openingPrompt=await buildOpeningForCaller(callerPhone);
    console.info('[CALL_FLOW] returning_caller_memory_found', { callId: activeKey, hasMemory: !!openingPrompt });
  } else {
    console.info('[CALL_FLOW] caller_memory_status', { callId: activeKey, callerKnown: callerPhone !== 'לא מזוהה', hasMemory: false });
  }

  while(true) {
    // IMPORTANT: send the previous answer and request the next turn in ONE read.
    // This avoids ending the Yemot action between turns and keeps the Call object,
    // turnHistory and YouTube result context alive.
    const prompt=nextPrompt || (firstTurn?(openingPrompt || process.env.FIRST_CALL_MESSAGE ||
      'שלום איך אפשר לעזור לך היום אמור בבקשה על מה תרצה לדבר אחרי הצפצוף ולסיום ההקלטה הקש סולמית'):
      'אמור שאלה נוספת ולסיום הקש סולמית או הקש כוכבית ליציאה');
    firstTurn=false;
    const recordPath=await call.read([{type:'text',data:prompt}],'record',
      {min_length:1,max_length:60,no_confirm_menu:true,timeout:10*60*1000});
    if(!recordPath || recordPath==='None') {
      emptyRecordAttempts++;
      if(emptyRecordAttempts < 3) {
        nextPrompt='לא הצלחתי לשמוע אותך. נסה שוב.';
        continue;
      }
      activeCalls.delete(activeKey);
      return call.id_list_message([{type:'text',data:'לא התקבלה תשובה. להתראות'}]);
    }
    emptyRecordAttempts=0;
    nextPrompt=null;

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
      if(active) active.status='מתמלל את ההקלטה ומעבד את השאלה';
      const israelNow=new Intl.DateTimeFormat('he-IL',{timeZone:'Asia/Jerusalem',dateStyle:'full',timeStyle:'short',hourCycle:'h23'}).format(new Date());
      userTranscript=await transcribePhoneAudio(audioBuffer);
      console.info('[CALL_FLOW] dedicated_transcript_ready',{callId:activeKey,transcript:userTranscript});
      if(!userTranscript || userTranscript.length<2) throw Object.assign(new Error('Empty phone transcription'),{status:400});
      // Avoid spending a Gemini generation call on requests that are already
      // handled by deterministic/direct data paths below. This reduces quota use,
      // improves phone latency, and leaves more capacity for real conversation/advice.
      const directDataRequest =
        isMultimodalAnalysisRequest(userTranscript).any ||
        isVisualContinuationRequest(userTranscript,historyText) ||
        !!answerIsraelTimeQuestion(userTranscript) ||
        !!answerDailyDateQuestion(userTranscript) ||
        isWeatherQuestion(userTranscript) ||
        isNewsQuestion(userTranscript) ||
        shouldForceWebSearch(userTranscript) ||
        /(חפש|תחפש|תמצא|חיפוש|באינטרנט|בגוגל|מה קורה עכשיו|מידע עדכני)/i.test(userTranscript) ||
        /(youtube|יוטיוב|ביויוטב|ביוטוב)/i.test(userTranscript);

      if(!directDataRequest) {
        const longAnswer=isLongAnswerRequest(userTranscript);
        const answerPrompt=EXCLUSIVE_INSTRUCTION+'\\n\\nהשעה והתאריך העדכניים בישראל לפי שעון השרת: '+israelNow+'. אם נשאלת מה השעה או מה התאריך, השתמש בערך הזה במדויק.'+'\\n\\nהקשר קודם של השיחה, לפי הסדר:\\n'+(historyText || 'אין עדיין הקשר קודם.')+'\\n\\nהשאלה המדויקת של המתקשר לאחר תמלול ייעודי:\\n'+userTranscript+'\\n\\n'+(longAnswer
          ? 'זו בקשה לתשובה ארוכה ומפורטת. אל תקצר ל-1 עד 4 משפטים. בנה תשובה רציפה ומסודרת, בדרך כלל 8 עד 20 פסקאות או משפטים קצרים לפי הצורך, עד כ-'+LONG_ANSWER_MAX_CHARS+' תווים. שמור על רצף טבעי להקראה בטלפון, בלי כותרות טכניות ובלי לחזור על עצמך. '
          : 'ענה בדרך כלל ב-1 עד 4 משפטים קצרים, אבל הרחב אם השאלה באמת דורשת זאת. ')+'החזר אובייקט JSON תקין בלבד עם שדה "answer". התשובה טבעית, אישית, חכמה וזורמת ומתאימה להקראה בטלפון. אם חסר פרט קריטי לעצה, שאל שאלה אחת ממוקדת. אם התמלול אינו ברור, אל תנחש ובקש מהמתקשר לחזור על השאלה.';
        const firstPass=(await generateBranch1WithFallback([{role:'user',parts:[{text:answerPrompt}]}],false,!longAnswer,longAnswer?LONG_ANSWER_TIMEOUT_MS:null)).response.text().trim();
        let parsedTurn=null;
        try { parsedTurn=JSON.parse(firstPass); } catch { const match=firstPass.match(/\\{[\\s\\S]*\\}/); if(match) { try { parsedTurn=JSON.parse(match[0]); } catch {} } }
        if(parsedTurn && typeof parsedTurn.answer==='string') {
          replyText=parsedTurn.answer.trim();
        } else {
          const cleaned=String(firstPass||'').trim();
          const answerMatch=cleaned.match(/"answer"\\s*:\\s*"([\\s\\S]*?)"\\s*(?:,|})/i);
          if(answerMatch && answerMatch[1]) replyText=answerMatch[1].replace(/\\\\n/g,' ').replace(/\\\\\"/g,'"').trim();
          else if(cleaned && cleaned.length<700) replyText=cleaned;
          else replyText='לא הצלחתי להבין את השאלה בבירור. נא לחזור עליה בבקשה';
        }
        console.info('[CALL_FLOW] gemini_answer_ok', { callId: activeKey, chars: replyText.length, transcriptReady: !!userTranscript });
      } else {
        console.info('[CALL_FLOW] direct_data_path_skip_initial_gemini', { callId: activeKey });
      }
      if (userTranscript && feedbackPending && /^(כן|כן בהחלט|בוודאי|בטח|מעולה|עזר|לא|לא עזר|לא ממש|לא כל כך)\\s*$/i.test(userTranscript)) {
        if (/^(כן|כן בהחלט|בוודאי|בטח|מעולה|עזר)/i.test(userTranscript)) replyText='מצוין. שמח שעזרתי לך. מה עוד תרצה שאעשה עבורך?';
        else replyText='בסדר. מה לא היה ברור או מה חסר לך? אמור לי ואנסה לעזור בצורה אחרת.';
        feedbackPending=false;
      }
      const deterministicDailyDateAnswer=answerDailyDateQuestion(userTranscript);
      if(deterministicDailyDateAnswer) replyText=deterministicDailyDateAnswer;
      const deterministicTimeAnswer=answerIsraelTimeQuestion(userTranscript);
      if(deterministicDailyDateAnswer) replyText=deterministicDailyDateAnswer;
      else if(deterministicTimeAnswer) replyText=deterministicTimeAnswer;
      else if(isWeatherQuestion(userTranscript)) {
        try { replyText=await answerWeatherDirect(userTranscript); }
        catch(e) { replyText=await answerWithWebSearch(userTranscript, historyText); }
      }
      else if(isNewsQuestion(userTranscript)) {
        try { replyText=await answerNewsDirect(userTranscript, historyText); }
        catch(e) { replyText=await answerWithWebSearch(userTranscript, historyText); }
      }
      else if(isTransitRequest(userTranscript)) {
        try {
          const transitAnswer=await answerTransitDirect(userTranscript);
          replyText=transitAnswer || await answerWithWebSearch(userTranscript, historyText);
        } catch(e) {
          console.warn('[TRANSIT] direct route unavailable; falling back to live web search',{status:geminiErrorStatus(e)});
          replyText=await answerWithWebSearch(userTranscript, historyText);
        }
      }
      else if(isMultimodalAnalysisRequest(userTranscript).any || isVisualContinuationRequest(userTranscript,historyText)) {
        const visualFollowUp=isVisualContinuationRequest(userTranscript,historyText);
        console.info('[MULTIMODAL] visual_route_selected',{
          callId:activeKey,
          visualFollowUp,
          transcript:userTranscript,
          historyHasVisualCue:/(איך נראה|איך היא נראית|איך הוא נראה|תמחיש|תמונה|צילום|תיאור חזותי|תיאור הפיזי|מה רואים)/i.test(historyText)
        });
        try {
          replyText=await analyzeRequestedMedia(userTranscript,{...turnContext,historyText});
          if(!replyText) throw Object.assign(new Error('Media analysis returned empty answer'),{status:503});
        } catch(e) {
          console.warn('[MULTIMODAL] analysis unavailable; falling back safely',{
            status:geminiErrorStatus(e),message:String(e?.message||e).slice(0,300)
          });
          if(e?.status===400) replyText='כדי לנתח תמונה או סרטון אני צריך מקור ציבורי נגיש.';
          else if(e?.status===429) replyText='מנוע ההמחשה הגיע כרגע למכסה. שמרתי את הבקשה וניסיתי מקור ציבורי חלופי; אפשר לנסות שוב בעוד כמה רגעים בלי לתת קישור.';
          else if(e?.status===404) replyText='לא מצאתי כרגע תמונה ציבורית נגישה שאפשר לנתח. אפשר לנסות שוב בניסוח מעט אחר.';
          else replyText='לא הצלחתי לנתח כרגע את המדיה שביקשת. המערכת ניסתה מקור נוסף אוטומטית, בלי לבקש ממך קישור.';
        }
      }
      else if(isPharmacySearchRequest(userTranscript)) {
        try {
          replyText=await answerPharmacySearchDirect(userTranscript);
        } catch(e) {
          replyText=await answerWithWebSearch(userTranscript, historyText);
        }
      }
      else if(shouldForceWebSearch(userTranscript) ||
        /(חפש|תחפש|תמצא|חיפוש|באינטרנט|בגוגל|מה קורה עכשיו|מידע עדכני)/i.test(userTranscript) ||
        /(youtube|יוטיוב|ביויוטב|ביוטוב)/i.test(userTranscript)) {
        try {
          const youtubeAnswer=await searchYouTubeForPhone(userTranscript, historyText, turnContext);
          if (youtubeAnswer) {
            replyText=youtubeAnswer;
          } else if (/(youtube|יוטיוב|ביויוטב|ביוטוב)/i.test(userTranscript)) {
            // Do not immediately fall back to another Gemini web-grounding call.
            // If YouTube search itself is unavailable, that second Gemini call
            // can consume the remaining quota and make the phone call fail twice.
            replyText='לא הצלחתי כרגע לקבל תוצאות מיוטיוב. נא לנסות שוב בעוד כמה רגעים.';
          } else {
            replyText=await answerWithWebSearch(userTranscript, historyText);
          }
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
    if(replyText.length>LONG_ANSWER_MAX_CHARS) {
      console.warn('[CALL_FLOW] long_answer_trimmed',{callId:activeKey,chars:replyText.length,max:LONG_ANSWER_MAX_CHARS});
      replyText=replyText.slice(0,LONG_ANSWER_MAX_CHARS).replace(/\\s+\\S*$/,'').trim()+'.';
    }
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
    // Do NOT call id_list_message here. It normally exits the action unless it is
    // queued with prependToNextAction. Instead, put the answer directly into the
    // next read: Yemot will play the answer and immediately collect the next turn.
    // This keeps the same phone call and the same in-memory conversation context.
    nextPrompt=replyText;
    feedbackPending=true;
    console.info('[CALL_FLOW] next_turn_armed', {
      callId: activeKey,
      historyTurns: turnHistory.length,
      youtubeContextResults: turnContext.youtubeResults.length
    });
  }
}


/**
 * Isolated YouTube IVR flow. Results live only in this call's async context.
 * Uses the same raw-recording -> Gemini transcription convention as the main robot.
 */
async function youtubeCallHandler(call) {
  // Conversational YouTube discovery only. We keep search/selection separate from
  // playback so the phone flow never waits on an unsupported media extraction job.
  let currentQuery='';
  let results=[];
  let resultOffset=0;
  let selectedVideo=null;
  let nextPrompt=null;

  const numberWords = {
    'אחד':1,'אחת':1,'ראשון':1,'ראשונה':1,'הראשון':1,'הראשונה':1,
    'שתיים':2,'שניים':2,'שתי':2,'שני':2,'שניה':2,'שנייה':2,'השני':2,'השניה':2,'השנייה':2,
    'שלוש':3,'שלושה':3,'שלישי':3,'שלישית':3,'השלישי':3,'השלישית':3,
    'ארבע':4,'ארבעה':4,'רביעי':4,'רביעית':4,'הרביעי':4,'הרביעית':4,
    'חמש':5,'חמישה':5,'חמישי':5,'חמישית':5,'החמישי':5,'החמישית':5,
    'שש':6,'שישה':6,'שישי':6,'שישית':6,'השישי':6,'השישית':6,
    'שבע':7,'שבעה':7,'שביעי':7,'שביעית':7,'השביעי':7,'השביעית':7,
    'שמונה':8,'שמיני':8,'שמינית':8,'השמיני':8,'השמינית':8,
    'תשע':9,'תשעה':9,'תשיעי':9,'תשיעית':9,'התשיעי':9,'התשיעית':9,
    'עשר':10,'עשרה':10,'עשירי':10,'עשירית':10,'העשירי':10,'העשירית':10
  };

  function spokenNumber(text) {
    const t=String(text||'').trim().toLowerCase().replace(/[.,!?;:]+/g,' ');
    const digit=t.match(/\b(\d{1,2})\b/);
    if(digit) return Number(digit[1]);
    for(const [word,n] of Object.entries(numberWords)) {
      if(new RegExp('(^|\\s)'+word+'($|\\s)','i').test(t)) return n;
    }
    return null;
  }

  function isMoreRequest(text) {
    return /(עוד|תוצאות נוספות|עוד תוצאות|הבא|הבאה|דף הבא|תראה עוד|תביא עוד)/i.test(String(text||''));
  }

  function isNewSearch(text) {
    return /(חפש|תחפש|תמצא|תאתר|חיפוש|נושא חדש|חיפוש חדש|משהו אחר)/i.test(String(text||''));
  }

  function isYes(text) {
    return /^(כן|כן בהחלט|בוודאי|בטח|אני רוצה|רוצה|כן אני רוצה|תשמיע|להשמיע|כן תשמיע)\\s*$/i.test(String(text||'').trim());
  }

  function isNo(text) {
    return /^(לא|לא תודה|לא רוצה|סיימתי|זה מספיק|תודה)\\s*$/i.test(String(text||'').trim());
  }

  function formatResultsPage() {
    const page=results.slice(resultOffset,resultOffset+5);
    if(!page.length) return 'אין עוד תוצאות זמינות לחיפוש הזה. אמור חיפוש חדש אם תרצה.';
    const lines=page.map((v,i) => {
      const n=resultOffset+i+1;
      return 'תוצאה מספר '+n+': '+sanitizeForYemot(v.title)+'. הערוץ: '+sanitizeForYemot(v.channelTitle)+'.';
    });
    resultOffset += page.length;
    return 'מצאתי כמה תוצאות. '+lines.join(' ')+' אמור את מספר התוצאה שאתה רוצה, או אמור עוד לעוד תוצאות.';
  }

  try {
    while(true) {
      const basePrompt = selectedVideo
        ? 'האם אתה רוצה לשמוע את הסרטון הזה? אמור כן או לא. ולסיום ההקלטה הקש סולמית'
        : (!results.length
          ? 'ברוכים הבאים לחיפוש ביוטיוב. אמור כל מה שאתה מחפש: נושא, אדם, ערוץ, שם סרטון, הסרטון הכי חדש, סרטונים בנושא מסוים או כל ניסוח אחר. אפשר גם לבקש עוד תוצאות. ולסיום ההקלטה הקש סולמית'
          : 'אמור את מספר התוצאה הרצויה, או אמור עוד כדי לקבל תוצאות נוספות, או חיפוש חדש כדי להתחיל חיפוש אחר. ולסיום ההקלטה הקש סולמית');

      const prompt=nextPrompt || basePrompt;
      nextPrompt=null;
      const recordPath=await call.read(
        [{type:'text',data:sanitizeForYemot(prompt)}],
        'record',
        {min_length:1,max_length:60,no_confirm_menu:true,timeout:10*60*1000}
      );
      if(!recordPath || recordPath==='None')
        return call.id_list_message([{type:'text',data:'לא נקלטה בקשה. להתראות'}]);

      const audioResponse=await withTimeout(
        yemotApi.download_file('ivr2:'+recordPath),
        REQUEST_TIMEOUT_MS,
        'youtube conversational recording download'
      );
      const transcript=await transcribePhoneAudio(audioResponse.data);
      console.info('[YouTube IVR] transcript',{chars:transcript.length,transcript});
      if(!transcript)
        return call.id_list_message([{type:'text',data:'לא הצלחתי להבין את הבקשה. נא לנסות שוב'}]);

      if(selectedVideo) {
        if(isYes(transcript)) {
          // Only play an exact, independently authorized audio source that was
          // explicitly mapped to this selected video ID. No YouTube extraction
          // or hidden stream discovery is performed.
          try {
            console.info('[YouTube IVR] playback requested', { videoId: selectedVideo.videoId });
            const playback = await withTimeout(
              downloadAuthorizedAudioToYemot(selectedVideo.videoId),
              Number(process.env.YOUTUBE_AUTHORIZED_PLAYBACK_TIMEOUT_MS || 90000),
              'authorized YouTube playback preparation'
            );
            if (!playback?.playbackPaths?.length) throw new Error('No playback files generated');

            console.info('[YouTube IVR] authorized playback ready', {
              videoId: selectedVideo.videoId,
              chunks: playback.chunkCount
            });

            const messages = [
              { type: 'text', data: 'מתחיל להשמיע את הסרטון המאושר.' },
              ...playback.playbackPaths.map(file => ({ type: 'file', data: file }))
            ];

            selectedVideo = null;
            // Yemot-router2 supports file messages directly. This makes the
            // phone call play the uploaded WAV chunks instead of waiting for
            // another HTTP request or trying to stream a remote YouTube URL.
            console.info('[YouTube IVR] playback response ready', { videoId: selectedVideo?.videoId || null, files: playback.playbackPaths.length });
            return call.id_list_message(messages, { removeInvalidChars: true });
          } catch (playbackError) {
            logDetailedError('YouTube authorized playback', playbackError);
            selectedVideo=null;
            nextPrompt='אין מקור שמע מורשה זמין לסרטון הזה. אפשר לבחור סרטון אחר. ולסיום ההקלטה הקש סולמית';
            continue;
          }
        }

        if(isNo(transcript) || isNewSearch(transcript)) {
          selectedVideo=null;
          results=[];
          resultOffset=0;
          currentQuery='';
          nextPrompt='בסדר. אמור עכשיו מה תרצה לחפש ביוטיוב. ולסיום ההקלטה הקש סולמית';
          continue;
        }
        nextPrompt='לא הבנתי אם אתה רוצה לשמוע את הסרטון. אמור כן או לא. ולסיום ההקלטה הקש סולמית';
        continue;
      }

      if(isMoreRequest(transcript) && results.length) {
        if(resultOffset>=results.length) {
          nextPrompt='אין עוד תוצאות שכבר נטענו. אמור חיפוש חדש כדי לבצע חיפוש נוסף. ולסיום ההקלטה הקש סולמית';
        } else {
          nextPrompt=formatResultsPage();
        }
        continue;
      }

      const selectedNumber=spokenNumber(transcript);
      if(results.length && selectedNumber!==null) {
        const idx=selectedNumber-1;
        if(idx>=0 && idx<results.length) {
          selectedVideo=results[idx];
          nextPrompt='בחרת את '+sanitizeForYemot(selectedVideo.title)+'. הערוץ הוא '+sanitizeForYemot(selectedVideo.channelTitle)+'. האם אתה רוצה לשמוע את הסרטון הזה? אמור כן או לא. ולסיום ההקלטה הקש סולמית';
          continue;
        }
        nextPrompt='המספר הזה לא נמצא ברשימה. אמור מספר מתוך התוצאות או אמור עוד. ולסיום ההקלטה הקש סולמית';
        continue;
      }

      if(isNewSearch(transcript) || !results.length) {
        currentQuery=transcript;
        results=await searchYouTubeVideos(currentQuery,{
          apiKey:process.env.YOUTUBE_API_KEY,
          regionCode:process.env.YOUTUBE_REGION_CODE||'IL',
          timeoutMs:REQUEST_TIMEOUT_MS
        });
        resultOffset=0;
        selectedVideo=null;

        if(!results.length) {
          nextPrompt='לא מצאתי תוצאות מתאימות ביוטיוב. נסה נושא, אדם, ערוץ או שם סרטון אחר. ולסיום ההקלטה הקש סולמית';
          continue;
        }

        nextPrompt=formatResultsPage();
        continue;
      }

      // If the caller gives a natural-language request while results are shown,
      // treat it as a fresh YouTube search rather than forcing keypad interaction.
      currentQuery=transcript;
      results=await searchYouTubeVideos(currentQuery,{
        apiKey:process.env.YOUTUBE_API_KEY,
        regionCode:process.env.YOUTUBE_REGION_CODE||'IL',
        timeoutMs:REQUEST_TIMEOUT_MS
      });
      resultOffset=0;
      selectedVideo=null;
      nextPrompt=results.length
        ? formatResultsPage()
        : 'לא מצאתי תוצאות מתאימות. אמור חיפוש חדש. ולסיום ההקלטה הקש סולמית';
    }
  } catch(error) {
    logDetailedError('YouTube IVR',error);
    const status=geminiErrorStatus(error);
    const message=status===429?'החיפוש עמוס כרגע. נא לנסות שוב':status===503?'שירות יוטיוב אינו זמין כרגע':'אירעה תקלה זמנית בחיפוש ביוטיוב. נא לנסות שוב';
    return call.id_list_message([{type:'text',data:message}]);
  }
}

async function answerBackupWithWebSearch(transcript, historyText='') {
  const question=String(transcript||'').trim();
  if(!question) throw Object.assign(new Error('Backup web search requested but transcript is empty'),{status:400});
  const prompt=EXCLUSIVE_INSTRUCTION+
    '\\n\\nהקשר קודם של השיחה:\\n'+(historyText||'אין עדיין הקשר קודם.')+
    '\\n\\nהשאלה המדויקת של המתקשר לחיפוש באינטרנט:\\n'+question+
    '\\n\\nבצע חיפוש אינטרנט חי ורחב באמצעות Google Search. פרק את הבקשה לכמה כיווני חיפוש כשצריך, העדף מקורות רשמיים ועדכניים, השווה בין מקורות ואל תמציא מידע. ענה בעברית טבעית, ברורה וקצרה להקראה בטלפון.';
  const result=await generateBackupWithRetry(
    [{role:'user',parts:[{text:prompt}]}],
    true
  );
  const answer=String(result?.response?.text?.()||'').trim();
  if(!answer) throw Object.assign(new Error('Backup web search returned empty answer'),{status:503});
  return answer;
}

// Backup branch configuration marker: branch 3 remains isolated from branch 1.
const BACKUP_GEMINI_API_KEY = (process.env.YEMOT_BACKUP_GEMINI_API_KEY || '').trim();
const backupGeminiClient = BACKUP_GEMINI_API_KEY ? new GoogleGenerativeAI(BACKUP_GEMINI_API_KEY) : null;
const backupModelNames = [...new Set([
  'gemini-3.1-flash-lite',
  ...(process.env.GEMINI_BACKUP_MODEL || '').split(',').map(x => x.trim()).filter(Boolean),
  ...MODEL_NAMES
])];
const backupGeminiModels = backupGeminiClient
  ? backupModelNames.map(model => backupGeminiClient.getGenerativeModel({model}))
  : [];
const backupGeminiWebModels = backupGeminiClient
  ? backupModelNames.map(model => backupGeminiClient.getGenerativeModel({model, tools:[{googleSearch:{}}]}))
  : [];
const backupGeminiModel = backupGeminiModels[0] || null;
const backupGeminiWebModel = backupGeminiWebModels[0] || null;

async function generateBackupWithRetry(contents, useWebSearch=false) {
  if (!backupGeminiClient || !backupGeminiModels.length)
    throw Object.assign(new Error('Backup Gemini is not configured'), {status:400});

  const models = useWebSearch ? backupGeminiWebModels : backupGeminiModels;
  let lastError;
  const perAttemptTimeout = Math.min(Math.max(3500, Math.floor(REQUEST_TIMEOUT_MS * 0.55)), 6000);

  for (let i=0; i<models.length; i++) {
    try {
      console.info('[Backup Gemini] trying model', {model:backupModelNames[i], useWebSearch});
      return await withTimeout(
        models[i].generateContent({contents}),
        perAttemptTimeout,
        'backup Gemini '+backupModelNames[i]
      );
    } catch (e) {
      lastError=e;
      console.warn('[Backup Gemini] model failed; trying next', {
        model:backupModelNames[i], status:geminiErrorStatus(e), useWebSearch
      });
    }
  }

  try {
    console.warn('[Backup Gemini] dedicated backup key exhausted; trying main Gemini pool');
    return await generateWithRetry(contents, useWebSearch, true);
  } catch (fallbackError) {
    lastError=fallbackError;
  }

  throw lastError;
}

function isDeepWebSearchRequest(text) {
  const q=String(text||'').toLowerCase().replace(/[״"'׳]/g,' ').replace(/\s+/g,' ').trim();
  return /(?:תחפש|חפש|חיפוש).{0,20}(?:באינטרנט|ברשת|בגוגל)|(?:בדוק|תבדוק).{0,20}(?:באינטרנט|ברשת|בגוגל)|חיפוש\s+(?:עמוק|יסודי)|תחפש\s+עמוק|חפש\s+עמוק|מחקר\s+(?:עמוק|יסודי)/.test(q);
}

function extractWebSearchQuery(text) {
  return String(text||'')
    .replace(/^(?:אז\s+)?(?:תחפש|חפש|בדוק|תבדוק)(?:\s+לי)?(?:\s+באינטרנט|\s+ברשת|\s+בגוגל)?/i,'')
    .replace(/^(?:באינטרנט|ברשת|בגוגל)\s*/i,'')
    .replace(/^(?:עמוק|יסודי|וממש\s+יסודי)\s*/i,'')
    .trim() || String(text||'').trim();
}

async function backupCallHandler(call) {
  const callerPhone=getCallerNumber(call);
  const callId=call?.callId || call?.values?.ApiCallId || '';
  const activeKey=String(callId || (Date.now()+'-'+callerPhone));
  activeCalls.set(activeKey,{id:activeKey,phone:callerPhone,callId:String(callId||''),
    startedAt:new Date().toISOString(),status:'ממתין להקלטה'});

  let firstTurn=true;
  let openingPrompt=null;
  let nextPrompt=null;
  let emptyRecordAttempts=0;
  let feedbackPending=false;
  const turnHistory=[];
  const turnContext={youtubeResults:[]};

  if(process.env.ENABLE_AI_OPENING!=='false' && callerPhone!=='לא מזוהה' &&
     conversationLog.some(x=>x.phone===callerPhone)) {
    openingPrompt=await buildOpeningForCaller(callerPhone);
    console.info('[BACKUP CALL_FLOW] returning_caller_memory_found',{callId:activeKey});
  }

  while(true) {
    const prompt=nextPrompt || (firstTurn
      ? (openingPrompt || process.env.FIRST_CALL_MESSAGE ||
        'שלום, איזה כיף לשמוע אותך. אני כאן איתך. מה תרצה לעשות עכשיו?')
      : 'אמור שאלה נוספת ולסיום הקש סולמית או הקש כוכבית ליציאה');
    firstTurn=false;

    const recordPath=await call.read(
      [{type:'text',data:prompt}],
      'record',
      {min_length:1,max_length:60,no_confirm_menu:true,timeout:10*60*1000}
    );

    if(!recordPath || recordPath==='None') {
      emptyRecordAttempts++;
      if(emptyRecordAttempts<3) {
        nextPrompt='לא הצלחתי לשמוע אותך. נסה שוב.';
        continue;
      }
      activeCalls.delete(activeKey);
      return call.id_list_message([{type:'text',data:'לא התקבלה תשובה. להתראות'}]);
    }
    emptyRecordAttempts=0;
    nextPrompt=null;

    const active=activeCalls.get(activeKey);
    if(active) active.status='הקלטה התקבלה — מתמלל ומעבד';

    try {
      const response=await withTimeout(
        yemotApi.download_file('ivr2:'+recordPath),
        REQUEST_TIMEOUT_MS,
        'backup recording download'
      );
      const audioBuffer=response.data;
      const historyText=turnHistory.map((t,i)=>
        'תור '+(i+1)+' — מתקשר: '+t.user+'\\nתשובה: '+t.assistant
      ).join('\\n\\n');

      const userTranscript=await transcribeBackupPhoneAudio(audioBuffer);
      console.info('[BACKUP CALL_FLOW] transcript_ready',{callId:activeKey,transcript:userTranscript});

      if(!userTranscript || userTranscript.length<2)
        throw Object.assign(new Error('Empty backup phone transcription'),{status:400});

      const israelNow=new Intl.DateTimeFormat('he-IL',{
        timeZone:'Asia/Jerusalem',dateStyle:'full',timeStyle:'short',hourCycle:'h23'
      }).format(new Date());

      let replyText='';
      const deterministicTime=answerIsraelTimeQuestion(userTranscript);
      if(deterministicTime) {
        replyText=deterministicTime;
      } else if(isWeatherQuestion(userTranscript)) {
        try { replyText=await answerWeatherDirect(userTranscript); }
        catch { replyText=await answerBackupWithWebSearch(userTranscript,historyText); }
      } else if(isNewsQuestion(userTranscript)) {
        replyText=await answerBackupWithWebSearch(userTranscript,historyText);
      } else {
        const webRequested=shouldForceWebSearch(userTranscript);
        const youtubeRequested=/(youtube|יוטיוב|ביויוטב|ביוטוב)/i.test(userTranscript);

        if(webRequested && !youtubeRequested) {
          replyText=await answerBackupWithWebSearch(userTranscript,historyText);
        } else if(youtubeRequested) {
          const youtubeAnswer=await searchYouTubeForPhone(userTranscript,historyText,turnContext,(process.env.YOUTUBE_BACKUP_API_KEY||'').trim());
          replyText=youtubeAnswer || 'לא הצלחתי כרגע לקבל תוצאות מיוטיוב. נא לנסות שוב בעוד כמה רגעים.';
        } else {
          const answerPrompt=EXCLUSIVE_INSTRUCTION+
            '\\n\\nהשעה והתאריך העדכניים בישראל לפי שעון השרת: '+israelNow+
            '. אם נשאלת מה השעה או מה התאריך, השתמש בערך הזה במדויק.'+
            '\\n\\nהקשר קודם של השיחה, לפי הסדר:\\n'+
            (historyText||'אין עדיין הקשר קודם.')+
            '\\n\\nהשאלה המדויקת של המתקשר לאחר תמלול ייעודי:\\n'+
            userTranscript+
            '\\n\\nענה על השאלה בלבד. החזר אובייקט JSON תקין בלבד עם שדה "answer". '+
            'התשובה טבעית, אישית, חכמה וזורמת ומתאימה להקראה בטלפון. '+
            'אם התמלול אינו ברור, אל תנחש ובקש מהמתקשר לחזור על השאלה.';
          const result=await generateBackupWithRetry(
            [{role:'user',parts:[{text:answerPrompt}]}],
            false
          );
          const raw=String(result?.response?.text?.()||'').trim();
          let parsed=null;
          try { parsed=JSON.parse(raw); } catch {
            const m=raw.match(/\{[\s\S]*\}/);
            if(m) { try { parsed=JSON.parse(m[0]); } catch {} }
          }
          replyText=String(parsed?.answer||raw||'לא הצלחתי לענות כרגע').trim();
        }
      }

      if(feedbackPending &&
         /^(כן|כן בהחלט|בוודאי|בטח|מעולה|עזר|לא|לא עזר|לא ממש|לא כל כך)\\s*$/i.test(userTranscript)) {
        replyText=/^(כן|כן בהחלט|בוודאי|בטח|מעולה|עזר)/i.test(userTranscript)
          ? 'מצוין. שמח שעזרתי לך. מה עוד תרצה שאעשה עבורך?'
          : 'בסדר. מה לא היה ברור או מה חסר לך? אמור לי ואנסה לעזור בצורה אחרת.';
        feedbackPending=false;
      }

      replyText=sanitizeForYemot(replyText)||'מצטער לא הצלחתי לנסח תשובה. נסה שוב.';
      const entry={id:Date.now()+'-'+conversationLog.length,time:new Date().toISOString(),
        phone:normalizePhone(callerPhone),callId:String(callId||''),
        user:userTranscript,gemini:replyText};
      conversationLog.push(entry);
      if(conversationLog.length>MAX_CONVERSATION_LOG)
        conversationLog.splice(0,conversationLog.length-MAX_CONVERSATION_LOG);
      await persistConversationEntry(entry);

      turnHistory.push({user:userTranscript,assistant:replyText});
      if(turnHistory.length>8) turnHistory.shift();

      console.info('[BACKUP CALL_FLOW] reply_ready',{
        callId:activeKey,chars:replyText.length,historyTurns:turnHistory.length
      });
      nextPrompt=replyText;
      feedbackPending=true;
    } catch(e) {
      logDetailedError('Backup Gemini processing',e);
      const status=geminiErrorStatus(e);
      nextPrompt=status===429
        ? 'מצטערים, מנוע הגיבוי הגיע כרגע למגבלת השימוש. נסה שוב בעוד כמה רגעים.'
        : status===408
          ? 'מצטערים, לקח יותר מדי זמן לענות. נסה שוב.'
          : 'מצטער, הייתה תקלה זמנית במערכת הגיבוי. אמור שוב את השאלה.';
    }
  }
}

router.get('/yemot', callHandler);
router.get('/yemot-backup', backupCallHandler);
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

app.get('/api/youtube/authorized-source', rateLimit(60, 60 * 1000, 'youtube-authorized-source'), requireDashboardAuth, async (req,res)=>{
  const videoId=String(req.query.videoId||'').trim();
  if(!/^[A-Za-z0-9_-]{6,20}$/.test(videoId))
    return res.status(400).json({error:'Invalid videoId'});
  if(!SUPABASE_ENABLED)
    return res.status(503).json({error:'Supabase is not configured'});
  try {
    const url=new URL(SUPABASE_URL+'/rest/v1/authorized_audio_sources');
    url.searchParams.set('select','video_id,source_url,enabled,created_at,updated_at');
    url.searchParams.set('video_id','eq.'+videoId);
    const response=await fetch(url,{
      headers:{apikey:SUPABASE_KEY,Authorization:'Bearer '+SUPABASE_KEY},
      signal:AbortSignal.timeout(10000)
    });
    if(!response.ok) return res.status(502).json({error:'Authorized source registry unavailable'});
    const rows=await response.json();
    return res.json({source:rows?.[0]||null});
  } catch(e) {
    logDetailedError('Authorized source lookup',e);
    return res.status(502).json({error:'Authorized source lookup failed'});
  }
});

app.post('/api/youtube/authorized-source', rateLimit(30, 60 * 1000, 'youtube-authorized-source-write'), requireDashboardAuth, async (req,res)=>{
  const videoId=String(req.body?.videoId||'').trim();
  const sourceUrl=String(req.body?.sourceUrl||'').trim();
  if(!/^[A-Za-z0-9_-]{6,20}$/.test(videoId))
    return res.status(400).json({error:'Invalid videoId'});
  if(!sourceUrl) return res.status(400).json({error:'Missing sourceUrl'});
  if(!SUPABASE_ENABLED) return res.status(503).json({error:'Supabase is not configured'});

  try {
    const parsed=new URL(sourceUrl);
    const allowedHosts=String(process.env.AUTHORIZED_AUDIO_HOSTS||'')
      .split(',').map(x=>x.trim().toLowerCase()).filter(Boolean);
    if(parsed.protocol!=='https:' || !allowedHosts.length || !allowedHosts.includes(parsed.hostname.toLowerCase()))
      return res.status(400).json({error:'Source URL must be HTTPS and use an allowlisted host'});

    const url=new URL(SUPABASE_URL+'/rest/v1/authorized_audio_sources');
    const response=await fetch(url,{
      method:'POST',
      headers:{
        apikey:SUPABASE_KEY,
        Authorization:'Bearer '+SUPABASE_KEY,
        'Content-Type':'application/json',
        Prefer:'resolution=merge-duplicates,return=representation'
      },
      body:JSON.stringify({
        video_id:videoId,
        source_url:parsed.toString(),
        enabled:true,
        updated_at:new Date().toISOString()
      })
    });
    const body=await response.text();
    if(!response.ok) return res.status(502).json({error:'Authorized source registry write failed'});
    let data=[]; try { data=JSON.parse(body); } catch {}
    return res.json({ok:true,source:data?.[0]||{video_id:videoId,source_url:parsed.toString(),enabled:true}});
  } catch(e) {
    logDetailedError('Authorized source registration',e);
    return res.status(400).json({error:'Invalid source URL'});
  }
});

app.delete('/api/youtube/authorized-source', rateLimit(30, 60 * 1000, 'youtube-authorized-source-delete'), requireDashboardAuth, async (req,res)=>{
  const videoId=String(req.query.videoId||'').trim();
  if(!/^[A-Za-z0-9_-]{6,20}$/.test(videoId))
    return res.status(400).json({error:'Invalid videoId'});
  if(!SUPABASE_ENABLED) return res.status(503).json({error:'Supabase is not configured'});
  try {
    const url=new URL(SUPABASE_URL+'/rest/v1/authorized_audio_sources');
    url.searchParams.set('video_id','eq.'+videoId);
    const response=await fetch(url,{
      method:'DELETE',
      headers:{apikey:SUPABASE_KEY,Authorization:'Bearer '+SUPABASE_KEY},
      signal:AbortSignal.timeout(10000)
    });
    if(!response.ok) return res.status(502).json({error:'Authorized source registry delete failed'});
    return res.json({ok:true,videoId});
  } catch(e) {
    logDetailedError('Authorized source deletion',e);
    return res.status(502).json({error:'Authorized source deletion failed'});
  }
});

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
  if (BACKUP_GEMINI_API_KEY) await updateExtension('ivr2:/3',{type:'api',api_link:publicUrl + '/yemot-backup'});
  else console.log('[Yemot automatic setup] Backup key missing; /3 was not changed');

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