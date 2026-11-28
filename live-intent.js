// Extensions 1 and 3 (owner, 19.11): "play me channel 14 live", "what is on
// live now", "play the live broadcast of X on YouTube", "the live stream of
// <site>". The call goes to extension 2's live player (the same relay as its
// TV channels, key 8): a named channel starts at once, a live page plays at
// once, "what's live" opens the channel menu, and a named live broadcast is
// searched there (YouTube and the whole web) and chosen with a key.
import { isCapabilityQuestion } from './caller-intent.js';

// The channels of extension 2, key 8 (branch2-tv.js there), by what callers say.
export const LIVE_CHANNELS = [
  { key: '7', title: 'רדיו איי 24 ניוז', rx: /רדיו\s*(?:של\s*)?(?:i24|איי\s*24|אי\s*24)/iu },
  { key: '8', title: 'רדיו ערוץ 14', rx: /רדיו\s*(?:של\s*)?(?:ערוץ\s*)?14|קול\s*14|רדיו\s*עכשיו\s*14/u },
  { key: '1', title: 'כאן 11', rx: /כאן\s*11|כאן\s*אחת\s*עשרה|ערוץ\s*11|ערוץ\s*כאן|כאן\s*חדשות|תאגיד השידור/u },
  { key: '2', title: 'ערוץ 12', rx: /ערוץ\s*12|ערוץ\s*שתים\s*עשרה|חדשות\s*12|קשת\s*12|\bN12\b/iu },
  { key: '3', title: 'ערוץ 13', rx: /ערוץ\s*13|ערוץ\s*שלוש\s*עשרה|חדשות\s*13|רשת\s*13/u },
  { key: '4', title: 'ערוץ 14', rx: /ערוץ\s*14|ערוץ\s*ארבע\s*עשרה|עכשיו\s*14|\bC14\b|now\s*14/iu },
  { key: '5', title: 'איי 24 ניוז', rx: /i24|איי\s*24|אי\s*24|איי\s*עשרים\s*וארבע/iu },
  { key: '6', title: 'ערוץ הכנסת', rx: /ערוץ\s*ה?כנסת/u }
];

const LIVE = /(?:(?:ב|ה)?שידור\s*(?:ה)?חי|ה?שידורים\s*ה?חיים|בלייב|לייב|\blive\b|משודר\s*עכשיו|משדרים\s*עכשיו|מה\s*משדרים|בזמן\s*אמת)/iu;
const RADIO = /(?:^|\s)(?:ה?רדיו|תחנת\s*רדיו)(?:\s|$)/u;
const ASK = /(?:תשמיע|תשמיעי|להשמיע|לשמוע|להאזין|תפתח|תפתחי|לפתוח|תדליק|תדליקי|תעביר|תעבירי|תכניס|תכניסי|תחבר|תחברי|אני רוצה|רוצה|אפשר|מה\s*(?:יש|משודר|משדרים)|איזה|אילו|תביא|תביאי|שים|שימי|תנגן|תנגני)/u;
const WHAT_LIVE = /(?:מה\s*(?:יש|משודר|משדרים)\s*(?:עכשיו\s*)?(?:ב?שידור\s*חי|בלייב|עכשיו)|אילו\s*שידורים|איזה\s*שידורים|שידורים\s*חיים\s*יש|רשימת\s*ה?ערוצים|ערוצי\s*ה?טלוויזיה|ערוצי\s*ה?רדיו)/u;
const DOMAIN = /\b([a-z0-9][a-z0-9-]{1,40}(?:\.[a-z0-9-]{2,30})*\.(?:co\.il|org\.il|net\.il|gov\.il|ac\.il|com|org|net|tv|fm|live|info|io))\b/i;

/**
 * { tv: { key, title } }  a named channel, straight to it
 * { tv: { menu: true } }  "what's live now": the channel menu
 * { tv: { url, title } }  a live page on a site he named by its address
 * { webQuery }            a live broadcast by name: searched in extension 2
 * null                    not a live-broadcast request
 */
export function liveIntent(text) {
  const t = String(text || '').normalize('NFKC').replace(/[״"!?]/g, ' ').replace(/\s+/g, ' ').trim();
  if (!t || isCapabilityQuestion(t) || /^(?:האם\s+)?(?:אתה|את|אתם)\s+(?:יכול|יכולה|יכולים|מסוגל|מסוגלת|יודע|יודעת)|(?:יש\s+לך|יש\s+לכם)\s+(?:אפשרות|שידור)|(?:אפשר|ניתן)\s+(?:בכלל\s+)?(?:ל|לשמוע).{0,20}\?$/u.test(t) && /\?|^האם|יכול|מסוגל|יש לך/u.test(String(text))) return null;
  // Spoken addresses: "kol chai dot co dot il" style is rare; written ones pass as is.
  const spoken = t.replace(/\s+(?:נקודה|דוט|dot)\s+/giu, '.');
  const live = LIVE.test(t), radio = RADIO.test(t);
  const ch = LIVE_CHANNELS.find(c => c.rx.test(t));
  // A channel needs "live"/"now"/"radio" or a request to hear it: "what did
  // channel 14 report" is a news question, not a broadcast.
  if (ch && (live || radio || /(?:עכשיו|כרגע)/u.test(t)) && (ASK.test(t) || live)) return { tv: { key: ch.key, title: ch.title } };
  if (!live && !(radio && ASK.test(t))) return null;
  if (!ASK.test(t) && !WHAT_LIVE.test(t)) return null;
  const dom = spoken.match(DOMAIN);
  if (dom) return { tv: { url: 'https://' + dom[1].toLowerCase(), title: 'השידור החי של ' + dom[1].toLowerCase() } };
  if (WHAT_LIVE.test(t)) return { tv: { menu: true } };
  // What is left after the request words is the name of the broadcast.
  const name = t.replace(LIVE, ' ').replace(/(?:תשמיע|תשמיעי|להשמיע|לשמוע|להאזין|תפתח|תפתחי|לפתוח|תדליק|תדליקי|תעביר|תעבירי|תכניס|תכניסי|תחבר|תחברי|אני רוצה|רוצה|אפשר|תביא|תביאי|שים|שימי|תנגן|תנגני|בבקשה|לי|את|של|עכשיו|כרגע|ביוטיוב|ביו טיוב|ביויוטב|מיוטיוב|יוטיוב|באינטרנט|ברשת|מהאתר|באתר|אתר|ה?שידור|ה?חי|ש|ה?רדיו)(?=\s|$)/gu, ' ').replace(/\s+/g, ' ').trim();
  if (name.replace(/\s/g, '').length < 2) return { tv: { menu: true } };
  return { webQuery: name + ' שידור חי' };
}

// A live broadcast by name, straight from YouTube's "live now" results
// (the server's yt-dlp, free): { url, title, channel } or null.
export async function findYoutubeLive(name, { timeoutMs = 14000, execImpl = null } = {}) {
  const q = String(name || '').replace(/\s*שידור חי\s*/gu, ' ').trim();
  if (q.length < 2) return null;
  const run = execImpl || (async args => { const { execFile } = await import('node:child_process'); return new Promise(res => execFile(process.env.YTDLP_BIN || '/usr/local/bin/yt-dlp', args, { timeout: timeoutMs, maxBuffer: 20 * 1024 * 1024 }, (e, out) => res(String(out || '')))); });
  const url = 'https://www.youtube.com/results?search_query=' + encodeURIComponent(q + ' שידור חי') + '&sp=EgJAAQ%253D%253D';
  let entries = [];
  try { entries = JSON.parse(await run(['--flat-playlist', '-J', '--no-warnings', '--ignore-errors', '--playlist-end', '12', url])).entries || []; } catch { return null; }
  const words = q.toLowerCase().split(/\s+/).filter(w => w.length > 1);
  const ok = entries.filter(e => /^[A-Za-z0-9_-]{11}$/.test(String(e?.id || '')) && (e.live_status === 'is_live' || e.live_status == null) && Number(e.age_limit || 0) < 18);
  const fit = e => { const t = (String(e.title || '') + ' ' + String(e.channel || e.uploader || '')).toLowerCase(); return words.filter(w => t.includes(w)).length; };
  // 28.11: a number in the name must be in the title or channel as a number of
  // its own ("ערוץ 14" got "ערוץ 10 בשידור חי" because "ערוץ" matched).
  const nums = q.match(/\d+/g) || [];
  const hasNums = e => { const t = String(e.title || '') + ' ' + String(e.channel || e.uploader || ''); return nums.every(n => new RegExp('(?:^|\\D)' + n + '(?:\\D|$)').test(t)); };
  const best = ok.filter(hasNums).map((e, i) => ({ e, s: fit(e) * 10 - i })).sort((a, b) => b.s - a.s)[0];
  if (!best || fit(best.e) === 0) return null;
  return { url: 'https://www.youtube.com/watch?v=' + best.e.id, title: String(best.e.title || q).slice(0, 120), channel: String(best.e.channel || best.e.uploader || '') };
}
