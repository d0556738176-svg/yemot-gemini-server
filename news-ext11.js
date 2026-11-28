// Owner, 25.11: extension 11 = online channels by topic, every new video the
// moment it can be downloaded, newest first, each topic in its own extension:
//   /11      menu (api): 1 news, 2 Torah lessons, 3 music, 4 technology
//   /11/N    playfile, start=max: the newest file first. Keys like extension 7
//            (1 +10s, 3 -10s, 4 older, 6 newer, 7 +3 min, 5 pause, * star menu,
//            8 details, 9 Hebrew dubbing saved to extension 7) plus
//            2 = delete this file (1 = confirm, 2 = cancel); 0 = back to /11,
//            # = main menu.
//   /11/N/A  archive A of topic N (when /11/N fills up), inside its own topic.
// Every file: downloaded on our server (free path only, never the paid
// engine), mastered at the owner's phone spec (WAV 16 kHz mono 16-bit; speech:
// low cut 100 Hz, gentle noise reduction, peak -2 dB; music -3 dB), uploaded
// to Yemot and deleted from the server at once. Kept until the owner deletes.
// A Yemot playfile folder numbers files 000-999: when one is full, its older
// half moves to the topic's next archive folder and the newer half moves down.
import { spawn } from 'node:child_process';
import { promises as fs, readFileSync, writeFileSync, mkdirSync, renameSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PLAY_KEYS } from './branch2-ext7.js';

// id: the channel id when known (checked: 25.11); handle: resolved on the
// server; query: found by YouTube's own channel search (checked in
// /news-status: the channel title found is shown next to each one).
// Owner, 27.11: 11/1 has two parts. 11/1/1: the main news channels;
// 11/1/2: news from many other channels. Channels found by their YouTube
// search are checked by name (names), so a wrong channel is never taken.
// dub: the channel speaks English; each video is turned into spoken Hebrew.
const q = (key, title, query, names, extra = {}) => ({ key, title, query, names, ...extra });
export const NEWS_CHANNELS = [
  { key: 'kikar', title: 'כיכר השבת', handle: 'kikarhashabat' },
  { key: '14', title: 'עכשיו 14', id: 'UCKEImtWikw9usC1pl_9m1nQ', handle: 'c14news' },
  q('arutz7', 'ערוץ 7', 'ערוץ 7 חדשות', ['ערוץ 7', 'Arutz Sheva', 'Arutz 7']),
  { key: '12', title: 'חדשות 12', handle: 'israelnews' },
  { key: 'i24', title: 'i24NEWS בעברית', id: 'UCisowXt5wZkp2sR3rFh9lnQ' },
  { key: 'kan', title: 'כאן חדשות', id: 'UC_HwfTAcjBESKZRJq6BTCpg', handle: 'KAN11NEWS' },
  { key: '13', title: 'חדשות 13', id: 'UCvQmPpU20hw1Trss_CVwaew' },
  q('ch16', 'ערוץ 16', 'ערוץ 16', ['ערוץ 16', 'Channel 16', 'ch16']),
];
export const OTHER_NEWS_CHANNELS = [
  // Owner, 27.11: from the main channels (11/1/1) to here, with their files.
  q('ch24', 'ערוץ 24', 'ערוץ 24 חדשות', ['ערוץ 24', 'Channel 24']),
  q('reshet13', 'רשת 13', 'רשת 13', ['רשת 13', 'Reshet 13']),
  q('kandigital', 'כאן דיגיטל', 'כאן דיגיטל תאגיד השידור הישראלי', ['כאן | דיגיטל', 'כאן דיגיטל']),
  { key: 'knesset', title: 'ערוץ כנסת', handle: 'KnessetTV' },
  q('leumanut', 'ערוץ לאומנות', 'ערוץ לאומנות', ['לאומנות']),
  q('mechadesh', 'חדשות המחדש', 'חדשות המחדש', ['המחדש']),
  q('israelhayom', 'ישראל היום', 'ישראל היום', ['ישראל היום', 'Israel Hayom']),
  q('yediot', 'ידיעות אחרונות', 'ידיעות אחרונות ynet', ['ידיעות אחרונות', 'ynet']),
  q('police', 'משטרת ישראל', 'משטרת ישראל', ['משטרת ישראל', 'Israel Police']),
  q('mabat', 'מבט מהשטח', 'מבט מהשטח', ['מבט מהשטח']),
  q('charedi', 'מה שמעניין בציבור החרדי', 'מה שמעניין בציבור החרדי', ['מה שמעניין בציבור החרדי']),
  q('derech', 'דרך המלך', 'דרך המלך חדשות', ['דרך המלך', 'Derech Hamelech'], { handles: ['derechhamelech', 'DerechHamelechNews'] }),
  q('idf', 'צה"ל', 'צה"ל - צבא ההגנה לישראל', ['צבא ההגנה לישראל', 'צה"ל', 'IDF']),
  q('yehezkeli', 'צבי יחזקאלי', 'צבי יחזקאלי', ['יחזקאלי', 'Yehezkeli']),
  q('kolbarama', 'רדיו קול ברמה', 'רדיו קול ברמה', ['קול ברמה']),
  q('aitelly', 'AiTelly', 'AiTelly', ['AiTelly'], { dub: true }),
  q('ihud', 'איחוד הצלה', 'איחוד הצלה ישראל', ['איחוד הצלה', 'United Hatzalah']),
  q('haaretz', 'הארץ', 'Haaretz הארץ', ['Haaretz', 'הארץ']),
  q('neiess', 'נייעס חמים', 'נייעס חמים', ['נייעס']),
  q('mod', 'משרד הביטחון', 'משרד הביטחון', ['משרד הביטחון', 'Ministry of Defense']),
  q('segal', 'עמית סגל', 'Amit Segal עמית סגל', ['עמית סגל', 'Amit Segal']),
  q('magal', 'ינון מגל', 'ינון מגל', ['ינון מגל', 'Yinon Magal', 'מגל'], { handles: ['yinonmagal', 'YinonMagal1', 'magalyinon'] }),
  q('shibolet', 'סלע מאיר - ספריית שיבולת', 'סלע מאיר - ספריית שיבולת', ['שיבולת', 'סלע מאיר']),
  q('kolchai', 'קול חי', 'קול חי', ['קול חי']),
  q('srugim', 'סרוגים', 'סרוגים', ['סרוגים', 'Srugim']),
  q('kolyehudi', 'הקול היהודי', 'הקול היהודי', ['הקול היהודי']),
  q('bennett', 'נפתלי בנט', 'Naftali Bennett נפתלי בנט', ['נפתלי בנט', 'Naftali Bennett']),
  q('united24', 'UNITED24', 'UNITED24', ['UNITED24'], { dub: true }),
  q('calcalist', 'כלכליסט', 'Calcalist כלכליסט', ['Calcalist', 'כלכליסט']),
  q('updates', 'חדשות ועדכונים', 'חדשות ועדכונים', ['חדשות ועדכונים', 'חדשות ועידכונים']),
  // The channel speaks Yiddish (checked 27.11): dubbed to Hebrew as well.
  { key: 'onedge', title: 'On Edge News', handle: 'OnEdgeNews', dub: true },
  q('taub', 'גדי טאוב: שומר סף', 'גדי טאוב שומר סף', ['שומר סף', 'גדי טאוב', 'Gadi Taub'], { handles: ['gaditaub', 'GadiTaub1', 'shomersaf'] }),
  q('kolmashekore', 'כל מה שקורה בציבור', 'כל מה שקורה בציבור החרדי', ['כל מה שקורה בציבור', 'כל מה שקורה']),
  q('shabak', 'שירות הביטחון הכללי', 'שב"כ שירות הביטחון הכללי', ['שירות הביטחון הכללי', 'Israeli Security Agency', 'שב"כ', 'Shin Bet'], { handles: ['shinbet', 'ISA_ShinBet', 'shabak'] }),
  q('privatenews', 'ThePrivatenews', 'ThePrivatenews', ['privatenews', 'private news'], { handles: ['ThePrivatenews', 'theprivatenews'] }),
  q('pikud', 'פיקוד העורף', 'פיקוד העורף', ['פיקוד העורף', 'Home Front Command'], { handles: ['pikudhaoref', 'PikudHaOref', 'IDFHomeFrontCommand'] }),
  q('gpo', 'לשכת העיתונות הממשלתית', 'Government Press Office Israel', ['Government Press Office', 'לשכת העיתונות', 'GPO'], { handles: ['GPOIsrael', 'israelgpo', 'GovernmentPressOffice'] }),
  q('crux', 'CRUX', 'CRUX news', ['CRUX'], { dub: true, handles: ['CRUX', 'cruxnews', 'CRUXnews'] }),
  q('bluepaw', 'Blue Paw Print', 'Blue Paw Print', ['Blue Paw Print', 'BluePawPrint'], { dub: true, handles: ['BluePawPrint', 'bluepawprint'] }),
  q('keshet12', 'קשת 12', 'קשת 12', ['קשת 12', 'Keshet 12', 'mako'], { handles: ['keshet12', 'Keshet12Official', 'mako'] }),
];
// Owner, 25.11: Torah lessons. Yedid Nefesh is not on YouTube: its own
// channel site (chatfree) lists the posts publicly, each video a plain file.
export const TORAH_CHANNELS = [
  { key: 'yedid', title: 'ידיד נפש', type: 'chatfree', base: 'https://yedid-nefesh.chatfree.app' },
  { key: 'hidabroot', title: 'הידברות', handle: 'hidabroot', query: 'הידברות' },
  { key: 'ch2000', title: 'ערוץ 2000', query: 'ערוץ 2000' },
  { key: 'gozal', title: 'הרב אילן גוזל', query: 'הרב אילן גוזל העמוד הרשמי' },
];
export const MUSIC_CHANNELS = [
  { key: 'ribo', title: 'ישי ריבו', query: 'ישי ריבו' },
  { key: 'shwekey', title: 'יעקב שוויקי', query: 'Yaakov Shwekey' },
  { key: 'steinmetz', title: 'מוטי שטיינמץ', query: 'מוטי שטיינמץ' },
  { key: 'fried', title: 'אברהם פריד', query: 'Avraham Fried' },
  { key: 'benari', title: 'חנן בן ארי', query: 'חנן בן ארי' },
  { key: 'turgeman', title: "עקיבא תורג'מן", query: "עקיבא תורג'מן", names: ["תורג'מן", 'Turgeman', 'עקיבא', 'Akiva'] },
  { key: 'herzlich', title: 'אלי הרצליך', query: 'אלי הרצליך' },
  { key: 'weber', title: 'בערי וובר', query: 'Beri Weber' },
  { key: 'shapiro', title: 'מרדכי שפירא', query: 'Mordechai Shapiro' },
  { key: 'dadya', title: 'איציק דדיה', query: 'איציק דדיה' },
  { key: 'ziongolan', title: 'ציון גולן', query: 'ציון גולן' },
];
export const TECH_CHANNELS = [
  // 27.11: Y4PC has no findable YouTube channel any more (the search gave an
  // unrelated English one), so it is left out.
  { key: 'gadgety', title: "גאדג'טי", query: "גאדג'טי gadgety", names: ["גאדג'טי", 'Gadgety'] },
  { key: 'hwzone', title: 'HWzone', query: 'HWzone', names: ['HWzone'] },
  { key: 'geektime', title: 'גיקטיים', query: 'Geektime גיקטיים', names: ['Geektime', 'גיקטיים'] },
];

export const NEWS_ROOT = '/11';
export const NEWS_DIR = '/11/1';
export const INDEX = 'ivr2:/2/youtubeaudio/news11_index.json';
export const MAX_FILES = 1000; // 000-999 in one playfile folder
export const FIRST_ARCHIVE = 1, LAST_ARCHIVE = 9;
export const NEWS_MARK = 'news11=yes';
// first: what the very first round of a topic takes (news: the last 2 hours;
// the others: the newest few of each channel, so the topic starts with content).
// news: the short/long download lanes, and a full folder drops its oldest
// files (owner, 27.11: the other topics keep every file until he deletes it).
export const TOPICS = {
  '1': { title: 'חדשות מהערוצים המרכזיים', menuTitle: 'חדשות אונליין', dir: '/11/1/1', news: true, kind: 'lesson', index: INDEX, priority: 0, firstHours: 2, maxAgeDays: 7, everyMin: 2, channels: NEWS_CHANNELS },
  '5': { title: 'חדשות שונות', dir: '/11/1/2', parent: '1', news: true, kind: 'lesson', index: 'ivr2:/2/youtubeaudio/news11_t5_index.json', priority: 0.5, firstHours: 2, maxAgeDays: 7, everyMin: 6, channels: OTHER_NEWS_CHANNELS },
  // Owner, 27.11: 11/2 in two parts - 11/2/1 the channels he chose,
  // 11/2/2 every Torah channel of LobbyTube.
  // Owner, 27.11: the chosen channels without a limit - every new lesson,
  // however old it is when found, checked every 5 minutes, its own lane.
  '2': { title: 'הערוצים הנבחרים', menuTitle: 'שיעורי תורה', dir: '/11/2/1', kind: 'lesson', index: 'ivr2:/2/youtubeaudio/news11_t2_index.json', priority: 1, firstPerChannel: 3, maxAgeDays: 3650, everyMin: 5, ownLane: true, channels: TORAH_CHANNELS },
  'T2': { title: 'כל ערוצי שיעורי התורה', dir: '/11/2/2', parent: '2', kind: 'lesson', index: 'ivr2:/2/youtubeaudio/news11_T2_index.json', priority: 1, maxAgeDays: 3, everyMin: 10, perDay: 15, channels: [] },
  // 26.11: singers upload seldom, so a 14-day limit left most of them empty;
  // the newest songs of each are taken even if months old (firstKey: their
  // first round is made again once with the new limit).
  '3': { title: 'מוזיקה', kind: 'song', index: 'ivr2:/2/youtubeaudio/news11_t3_index.json', priority: 2, firstPerChannel: 3, maxAgeDays: 365, firstKey: 'v2', everyMin: 15, channels: MUSIC_CHANNELS },
  '4': { title: 'טכנולוגיה', kind: 'lesson', index: 'ivr2:/2/youtubeaudio/news11_t4_index.json', priority: 2, firstPerChannel: 2, maxAgeDays: 14, everyMin: 15, channels: TECH_CHANNELS },
};
const STATE_DIR = process.env.NEWS_STATE_DIR || path.join(os.homedir(), 'yemot-news');

// ---- LobbyTube topics (owner, 27.11) ----
// The owner opened lobbytube.co.il in his own browser; the channel lists of
// its topics (every channel each topic shows) came from there into
// lobby.json. Each topic of the site is a folder of 11 (11/5 on), except
// its news topic; Torah lessons, music and technology join 11/2, 11/3, 11/4.
// Thousands of channels: each round looks at a slice of them (the feeds are
// spread over hours), a channel's first round takes only its newest video
// of the last 3 days, and each topic gets at most LOBBY_PER_DAY files a day.
export const LOBBY_FILE = path.join(STATE_DIR, 'lobby.json');
export const LOBBY_SKIP = ['חדשות ואקטואליה'];
const LOBBY_JOIN = { 'שיעורי תורה': 'T2', 'מוזיקה': '3', "טכנולוגיה וגאדג'טים": '4' };
const LOBBY_SONGS = ['מוזיקה', 'חדשות מוזיקה'];
export const LOBBY_PER_DAY = Number(process.env.LOBBY_PER_DAY || 15);
const LOBBY_SLICE = Number(process.env.LOBBY_SLICE || 15);
export function applyLobby(data) {
  const cats = data?.cats || {};
  // A topic keeps its folder once it has one (found by its name); a new one
  // takes the next free folder.
  let folder = Math.max(4, ...Object.values(TOPICS).filter(x => x.lobby).map(x => Number(x.dir.split('/')[2]) || 0)) + 1, added = 0;
  for (const name of data?.order || Object.keys(cats)) {
    if (LOBBY_SKIP.includes(name) || !Array.isArray(cats[name])) continue;
    const ids = [...new Set(cats[name].filter(id => /^UC[A-Za-z0-9_-]{22}$/.test(id)))];
    let t = LOBBY_JOIN[name] || Object.keys(TOPICS).find(k => TOPICS[k].lobby && TOPICS[k].title === name);
    if (!t) {
      t = 'L' + folder;
      TOPICS[t] ||= { title: name, dir: NEWS_ROOT + '/' + folder, lobby: true, kind: LOBBY_SONGS.includes(name) ? 'song' : 'lesson',
        index: 'ivr2:/2/youtubeaudio/news11_' + t + '_index.json', priority: 3, maxAgeDays: 3, everyMin: 30, perDay: LOBBY_PER_DAY, channels: [] };
      folder++;
    }
    const topic = TOPICS[t];
    const have = new Set(topic.channels.map(c => c.id).filter(Boolean));
    topic.channels = topic.channels.filter(c => !c.lobby);
    for (const id of ids) {
      if (have.has(id)) continue;
      topic.channels.push({ key: 'lb_' + id, title: '', id, lobby: true, firstPerChannel: 1, maxAgeDays: 3 });
      added++;
    }
  }
  return added;
}
// The lists the owner brought from LobbyTube (27.11) ship with the code;
// a newer import on this server goes before them.
const LOBBY_SHIPPED = new URL('./lobby-channels.json', import.meta.url);
export function loadLobby() {
  // The shipped lists first (they fix the folder numbers), then what was
  // imported on this server, topic by topic.
  let n = 0;
  for (const f of [LOBBY_SHIPPED, LOBBY_FILE]) { try { n += applyLobby(JSON.parse(readFileSync(f, 'utf8'))); } catch {} }
  return n;
}
export function importLobby(data) {
  const clean = { at: new Date().toISOString(), order: [], cats: {} };
  for (const [name, ids] of Object.entries(data?.cats || {})) {
    if (typeof name !== 'string' || name.length > 60 || !Array.isArray(ids)) continue;
    clean.order.push(name);
    clean.cats[name] = ids.filter(id => /^UC[A-Za-z0-9_-]{22}$/.test(String(id))).slice(0, 3000);
  }
  if (Array.isArray(data?.order)) clean.order = data.order.filter(n => clean.cats[n]);
  mkdirSync(STATE_DIR, { recursive: true });
  writeFileSync(LOBBY_FILE, JSON.stringify(clean));
  return { topics: clean.order.length, channels: Object.values(clean.cats).reduce((a, b) => a + b.length, 0), added: applyLobby(clean) };
}
const STATE_FILE = path.join(STATE_DIR, 'state.json');

export const file3 = n => String(n).padStart(3, '0');
export const topicDir = t => TOPICS[t]?.dir || NEWS_ROOT + '/' + t;
export const archiveDir = (t, a) => topicDir(t) + '/' + a;
// The topics on the first menu (11/1 holds two, 11/1/1 and 11/1/2).
export const menuTopics = () => Object.keys(TOPICS).filter(k => !TOPICS[k].parent);
export const childTopics = k => [k, ...Object.keys(TOPICS).filter(c => TOPICS[c].parent === k)];
// "/11/2" -> { t: '2', a: 0 }; "/11/2/3" -> { t: '2', a: 3 }; "/11/1/2/4" -> { t: '5', a: 4 }.
export function topicOfDir(dir) {
  const d = String(dir || '').replace(/\/+$/, '');
  for (const t of Object.keys(TOPICS)) {
    const base = topicDir(t);
    if (d === base) return { t, a: 0 };
    const m = new RegExp('^' + base.replace(/\//g, '\\/') + '\\/([1-9])$').exec(d);
    if (m) return { t, a: Number(m[1]) };
  }
  return null;
}
const topicOf = q => TOPICS[q?.topic] ? String(q.topic) : '1';

// ---- Yemot settings ----
export function playIni(publicUrl, dir, title) {
  const keys = { ...PLAY_KEYS };
  keys.control_play2 = 'send_api'; // delete this file (asks 1 / 2 first)
  keys.control_play0 = 'go_to_folder';
  keys.playfile_control_play_0_goto = NEWS_ROOT;
  keys['control_play#'] = 'go_to_folder';
  keys['playfile_control_play_#_goto'] = '/';
  return ['type=playfile', 'title=' + title, 'start=max', 'save_last_play=yes',
    'api_link=' + String(publicUrl || '').replace(/\/$/, '') + '/yemot-media',
    ...Object.entries(keys).map(([k, v]) => k + '=' + v), NEWS_MARK].join('\n') + '\n';
}
// 11/1: asks which part (1 main channels, 2 other channels).
export function partMenuIni(publicUrl, parent) {
  return ['type=api', 'api_link=' + String(publicUrl || '').replace(/\/$/, '') + '/yemot-youtube', 'api_add_0=news=menu', 'api_add_1=news_parent=' + parent, 'title=' + TOPICS[parent].menuTitle, NEWS_MARK].join('\n') + '\n';
}
export function menuIni(publicUrl) {
  return ['type=api', 'api_link=' + String(publicUrl || '').replace(/\/$/, '') + '/yemot-youtube', 'api_add_0=news=menu', 'title=ערוצים אונליין', NEWS_MARK].join('\n') + '\n';
}

// ---- Feeds ----
const ent = s => String(s || '').replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1').replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n))).replace(/&amp;/g, '&').trim();
export function parseFeed(xml) {
  const out = [];
  const channelTitle = ent((/<feed[\s\S]*?<title>([\s\S]*?)<\/title>/.exec(String(xml || '')) || [])[1]);
  for (const m of String(xml || '').matchAll(/<entry>([\s\S]*?)<\/entry>/g)) {
    const e = m[1];
    const videoId = (/<yt:videoId>([A-Za-z0-9_-]{11})<\/yt:videoId>/.exec(e) || [])[1];
    if (!videoId) continue;
    out.push({ videoId, title: ent((/<title>([\s\S]*?)<\/title>/.exec(e) || [])[1]),
      published: (/<published>([^<]+)<\/published>/.exec(e) || [])[1] || null,
      short: /\/shorts\//.test((/<link[^>]*href="([^"]+)"/.exec(e) || [])[1] || '') });
  }
  return { channelTitle, items: out };
}
export const feedUrl = id => 'https://www.youtube.com/feeds/videos.xml?channel_id=' + id;
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36';

// The channel id behind a handle (the channel page names it).
export async function resolveHandle(handle, fetchImpl = fetch) {
  const r = await fetchImpl('https://www.youtube.com/@' + encodeURIComponent(handle), { headers: { 'user-agent': UA, 'accept-language': 'he,en;q=0.8', cookie: 'CONSENT=YES+1' }, signal: AbortSignal.timeout(20000) });
  const html = await r.text();
  const id = (/<link rel="canonical" href="https:\/\/www\.youtube\.com\/channel\/(UC[A-Za-z0-9_-]{22})"/.exec(html) || /"externalId":"(UC[A-Za-z0-9_-]{22})"/.exec(html) || /"channelId":"(UC[A-Za-z0-9_-]{22})"/.exec(html) || [])[1];
  return id || null;
}

// The channel YouTube's own channel search puts first for a name. 26.11: an
// automatic "- Topic" channel is never taken (עקיבא תורג'מן came out as
// "Zusha - Topic"), and a channel whose title carries one of the singer's
// names goes before the others.
export const searchSeen = {};
export function pickChannel(html, names = [], seenKey = '') {
  const found = [...String(html || '').matchAll(/"channelRenderer":\{"channelId":"(UC[A-Za-z0-9_-]{22})","title":\{"simpleText":"((?:[^"\\]|\\.)*)"/g)]
    .map(m => ({ id: m[1], title: m[2] }));
  // What the search showed (status), to see why a channel was not taken.
  if (seenKey) searchSeen[seenKey] = { at: new Date().toISOString(), htmlLen: String(html || '').length, titles: found.slice(0, 5).map(c => c.title) };
  if (!found.length) return (/"channelRenderer":\{"channelId":"(UC[A-Za-z0-9_-]{22})"/.exec(String(html || '')) || [])[1] || null;
  const ok = found.filter(c => !/\s[-–]\s*Topic$|\s[-–]\s*נושא$/i.test(c.title));
  const low = names.map(n => String(n).toLowerCase()).filter(n => n.length >= 3);
  const named = ok.find(c => low.some(n => c.title.toLowerCase().includes(n)));
  if (named || low.length) return named?.id || null;
  return ok[0]?.id || (/"channelRenderer":\{"channelId":"(UC[A-Za-z0-9_-]{22})"/.exec(String(html || '')) || [])[1] || null;
}
export async function resolveQuery(q, fetchImpl = fetch, names = [], seenKey = '') {
  const r = await fetchImpl('https://www.youtube.com/results?search_query=' + encodeURIComponent(q) + '&sp=EgIQAg%253D%253D', { headers: { 'user-agent': UA, 'accept-language': 'he,en;q=0.8', cookie: 'CONSENT=YES+1' }, signal: AbortSignal.timeout(20000) });
  return pickChannel(await r.text(), names, seenKey);
}
// A channel's own page: its id and its name (27.11: a handle is taken only
// when the name matches, like a search).
export async function handleInfo(handle, fetchImpl = fetch) {
  const r = await fetchImpl('https://www.youtube.com/@' + encodeURIComponent(handle), { headers: { 'user-agent': UA, 'accept-language': 'he,en;q=0.8', cookie: 'CONSENT=YES+1' }, signal: AbortSignal.timeout(20000) });
  if (!r.ok) return null;
  const html = await r.text();
  const id = (/<link rel="canonical" href="https:\/\/www\.youtube\.com\/channel\/(UC[A-Za-z0-9_-]{22})"/.exec(html) || /"externalId":"(UC[A-Za-z0-9_-]{22})"/.exec(html) || [])[1];
  const title = (/<meta property="og:title" content="([^"]*)"/.exec(html) || [])[1] || '';
  return id ? { id, title } : null;
}

// ---- A channel site (chatfree, e.g. Yedid Nefesh): its public post list
// (sitemap) and each post's public page, where the video is a plain file. ----
export function parseSitemapPosts(xml) {
  return [...new Set([...String(xml || '').matchAll(/\/post\/(\d+)</g)].map(m => Number(m[1])))].sort((a, b) => b - a);
}
export function parsePostPage(html) {
  const h = String(html || '');
  const video = (/video-embedded#?\]\((https:\/\/[^)\s"<>]+)\)/.exec(h) || /<meta property="og:video(?::url)?" content="([^"]+)"/.exec(h) || [])[1] || null;
  const raw = ent((/<meta property="og:title" content="([^"]*)"/.exec(h) || /<title>([\s\S]*?)<\/title>/.exec(h) || [])[1] || '');
  const title = raw.replace(/\s*\|[^|]*$/, '').replace(/\[(?:video|image)-embedded[^\]]*\]\([^)]*\)?/g, ' ').replace(/(?:video|image)-embedd\S*/g, ' ').replace(/[#*_`>]+/g, ' ').replace(/…/g, ' ').replace(/\s+/g, ' ').trim().replace(/[\s\[\]()|]+$/, '').slice(0, 160);
  const published = (/<time datetime="([^"]+)"/.exec(h) || /"datePublished":"([^"]+)"/.exec(h) || /article:published_time" content="([^"]+)"/.exec(h) || [])[1] || null;
  return { video, title, published };
}

// ---- Local state (a small list, never media) ----
export function loadState() { try { return JSON.parse(readFileSync(STATE_FILE, 'utf8')); } catch { return {}; } }
export function saveState(s) { try { mkdirSync(STATE_DIR, { recursive: true }); writeFileSync(STATE_FILE + '.tmp', JSON.stringify(s)); renameSync(STATE_FILE + '.tmp', STATE_FILE); } catch {} }

export const status = { started: null, lastPoll: null, channels: {}, queue: [], working: {}, log: [], rotation: null, first: null };
const note = x => { status.log.unshift({ at: new Date().toISOString(), ...x }); status.log.length = Math.min(status.log.length, 60); };

// One round over the channels of every topic that is due. New videos are
// queued; a topic's first round ever takes only the last 2 hours (news) or the
// newest few of each channel (the other topics), never a channel's history.
const searchBudget = { left: 0 };
async function channelIds(ch, st, row, deps, now) {
  let ids = st.ids[ch.key];
  const sig = JSON.stringify([ch.id || '', ch.handle || '', ch.query || '', ch.names || [], ch.handles || []]);
  if (!ids || !ids.length || (st.idsAt?.[ch.key] || 0) < now - 24 * 3600e3 || (st.idsSig?.[ch.key] || '') !== sig) {
    const set = new Set(ch.id ? [ch.id] : []);
    if (ch.handle) { const r = await resolveHandle(ch.handle, deps.fetch).catch(e => { row.resolveError = String(e?.message || e).slice(0, 100); return null; }); if (r) set.add(r); }
    // 27.11: YouTube's search answers nothing when asked many times at once,
    // so a few searches per round, spaced, and a failed one waits 20 minutes.
    st.searchTried ||= {};
    if (!set.size && ch.query && (searchBudget.left <= 0 || (st.searchTried[ch.key] || 0) > now - 20 * 60000)) return ids || [];
    if (!set.size && ch.query) { searchBudget.left--; st.searchTried[ch.key] = now; if (deps.searchGapMs !== 0) await new Promise(r => setTimeout(r, deps.searchGapMs || 2500)); }
    // Possible handles, each taken only when its name matches.
    for (const h of ch.handles || []) {
      if (set.size) break;
      const info = await handleInfo(h, deps.fetch).catch(() => null);
      const low = (ch.names || []).map(n => n.toLowerCase());
      if (info && (!low.length || low.some(n => info.title.toLowerCase().includes(n)))) set.add(info.id);
      else searchSeen[ch.key + '@' + h] = { title: info?.title || null };
    }
    if (!set.size && ch.query) { const r = await resolveQuery(ch.query, deps.fetch, ch.names || [], ch.key).catch(e => { row.resolveError = String(e?.message || e).slice(0, 100); return null; }); if (r) set.add(r); }
    if (set.size) { ids = [...set]; st.ids[ch.key] = ids; (st.idsAt ||= {})[ch.key] = now; (st.idsSig ||= {})[ch.key] = sig; }
  }
  return ids || [];
}
function consider(st, t, topic, ch, it, now, firstRun, rank) {
  // A channel's first round made again (new limits): what it skipped before
  // as too old or before the start is looked at once more.
  if (firstRun === 'again' && (st.seen[it.id] === 'old' || st.seen[it.id] === 'before-start')) delete st.seen[it.id];
  if (st.seen[it.id] || st.queue[it.id]) return;
  const age = now - (Date.parse(it.published) || now);
  if (firstRun && topic.firstHours && age > topic.firstHours * 3600e3) { st.seen[it.id] = 'before-start'; return; }
  const perChannel = ch.firstPerChannel ?? topic.firstPerChannel;
  if (firstRun && perChannel != null && rank >= perChannel) { st.seen[it.id] = 'before-start'; return; }
  const maxAgeDays = ch.maxAgeDays || topic.maxAgeDays || 7;
  if (age > maxAgeDays * 86400e3) { st.seen[it.id] = 'old'; return; }
  st.queue[it.id] = { topic: t, ch: ch.key, chTitle: ch.title, ...(ch.dub ? { dub: true } : {}), ...(ch.lobby ? { lobby: true, maxAgeDays } : {}), ytChannel: it.channel || null, title: it.title, published: it.published, short: !!it.short, src: it.url ? 'url' : 'yt', url: it.url || null, tries: 0, nextAt: 0, added: new Date(now).toISOString() };
  note({ queued: it.id, topic: t, ch: ch.key, title: String(it.title || '').slice(0, 80) });
}
// 27.11: 11/1 became two parts; the files that were in 11/1 move to 11/1/1
// (same numbers), once.
export function moveNewsToMainPart(io, t = '1', oldDir = NEWS_DIR) {
  return serial(async () => {
    const idx = await readIndex(io, t);
    if (idx.layout === 'main-part') return 0;
    const to = topicDir(t);
    let moved = 0;
    for (const e of Object.values(idx.items || {})) {
      if (e.dir !== oldDir) continue;
      await io.move('ivr2:' + oldDir + '/' + e.file + '.wav', 'ivr2:' + to + '/' + e.file + '.wav').then(() => moved++).catch(() => {});
      e.dir = to;
    }
    idx.layout = 'main-part';
    await io.writeJson(indexOf(t), idx); rememberIndex(t, idx);
    note({ movedToMainPart: moved, topic: t });
    return moved;
  });
}
// Owner, 27.11: channels moved from one news part to the other take their
// files with them (the next free numbers there), once per move.
export const CHANNEL_MOVES = [
  { id: 'main-to-other-27.11', from: '1', to: '5', ch: ['ch24', 'reshet13', 'kandigital'] },
  // The LobbyTube Torah channels' files: from 11/2/1 to 11/2/2.
  { id: 'torah-lobby-27.11', from: '2', to: 'T2', ch: c => String(c || '').startsWith('lb_') },
];
const movesChannel = (mv, c) => typeof mv.ch === 'function' ? mv.ch(c) : mv.ch.includes(c);
export function moveChannelFiles(io, st) {
  return serial(async () => {
    let moved = 0;
    for (const mv of CHANNEL_MOVES) {
      const from = await readIndex(io, mv.from);
      if ((from.moves || []).includes(mv.id)) continue;
      const to = await readIndex(io, mv.to);
      const toDir = topicDir(mv.to);
      for (const [v, e] of Object.entries(from.items || {})) {
        if (!movesChannel(mv, e.ch)) continue;
        if ((to.next || 0) >= MAX_FILES) break;
        const file = file3(to.next || 0);
        try { await io.move('ivr2:' + e.dir + '/' + e.file + '.wav', 'ivr2:' + toDir + '/' + file + '.wav'); }
        catch { continue; }
        to.next = (to.next || 0) + 1;
        to.items = { ...(to.items || {}), [v]: { ...e, dir: toDir, file } };
        delete from.items[v];
        moved++;
      }
      from.moves = [...(from.moves || []), mv.id];
      await io.writeJson(indexOf(mv.to), to); rememberIndex(mv.to, to);
      await io.writeJson(indexOf(mv.from), from); rememberIndex(mv.from, from);
      for (const q of Object.values(st?.queue || {})) if (q.topic === mv.from && movesChannel(mv, q.ch)) q.topic = mv.to;
    }
    if (moved) note({ channelFilesMoved: moved });
    return moved;
  });
}
// 27.11: a channel taken out of a topic's list (it came out as the wrong
// channel) has its files and queued videos removed, once per start.
let droppedChecked = false;
export async function removeDroppedChannels(io, st) {
  let removed = 0;
  for (const t of Object.keys(TOPICS)) {
    if (TOPICS[t].news) continue;
    // Only a channel that is in no topic at all (a channel moved to another
    // topic keeps its files there).
    const keys = new Set(Object.values(TOPICS).flatMap(x => x.channels.map(c => c.key)));
    for (const [v, q] of Object.entries(st.queue || {})) if (topicOf(q) === t && q.ch && !keys.has(q.ch)) { delete st.queue[v]; st.seen[v] = 'dropped-channel'; }
    const idx = await readIndex(io, t);
    for (const e of Object.values(idx.items || {})) {
      if (!e.ch || keys.has(e.ch)) continue;
      await deleteNews(e.dir, e.file, io).then(() => removed++).catch(() => {});
    }
  }
  if (removed) note({ droppedChannelFiles: removed });
  return removed;
}
// The owner's own channels every round; the LobbyTube channels a slice at a
// time (the next slice each round), so their feeds are spread out.
function channelsThisRound(t, topic, st) {
  const fixed = topic.channels.filter(c => !c.lobby), lobby = topic.channels.filter(c => c.lobby);
  if (!lobby.length) return fixed;
  st.lobbyCursor ||= {};
  const from = (st.lobbyCursor[t] || 0) % lobby.length;
  const part = lobby.slice(from, from + LOBBY_SLICE);
  st.lobbyCursor[t] = from + part.length >= lobby.length ? 0 : from + part.length;
  return [...fixed, ...part];
}
export async function pollOnce(deps, now = Date.now()) {
  const st = loadState();
  searchBudget.left = deps.searchesPerRound ?? 6;
  if (deps.io && !droppedChecked) { droppedChecked = true; st.seen ||= {}; await moveNewsToMainPart(deps.io).catch(() => 0); await moveNewsToMainPart(deps.io, '2', NEWS_ROOT + '/2').catch(() => 0); await moveChannelFiles(deps.io, st).catch(() => 0); await removeDroppedChannels(deps.io, st).catch(() => 0); }
  st.seen ||= {}; st.queue ||= {}; st.ids ||= {}; st.topicStarted ||= {}; st.topicPolled ||= {};
  if (!st.started) st.started = new Date(now).toISOString();
  // The news ran alone before topics existed: its first round was then.
  if (!st.topicStarted['1'] && Object.keys(st.seen).length) st.topicStarted['1'] = st.started;
  const topics = deps.topics || Object.keys(TOPICS);
  for (const t of topics) {
    const topic = TOPICS[t];
    if (!deps.force && (st.topicPolled[t] || 0) > now - (topic.everyMin || 2) * 60000 + 20000) continue;
    st.topicPolled[t] = now;
    const firstRun = !st.topicStarted[t];
    for (const ch of channelsThisRound(t, topic, st)) {
      const row = status.channels[ch.key] ||= { title: ch.title, topic: t };
      // A channel new to its topic, or one whose search changed (it came out
      // as the wrong channel before), gets its own first round.
      const chMark = t + ':' + ch.key + ':' + (topic.firstKey || '') + ':' + (ch.names ? 'n' : '');
      st.chStarted ||= {};
      const chFirst = ch.lobby ? !st.chStarted[chMark] : firstRun || ((st.topicStarted[t] && !st.chStarted[chMark] && (topic.firstKey || ch.names)) ? 'again' : false);
      try {
        if (ch.type === 'chatfree') {
          const sm = await deps.fetch(ch.base + '/sitemap.xml', { headers: { 'user-agent': UA }, signal: AbortSignal.timeout(20000) });
          if (!sm.ok) throw new Error('site list HTTP ' + sm.status);
          const posts = parseSitemapPosts(await sm.text()).slice(0, firstRun ? 12 : 25);
          let rank = 0;
          for (const p of posts) {
            const id = ch.key + p;
            if (st.seen[id] || st.queue[id]) { rank++; continue; }
            const r = await deps.fetch(ch.base + '/post/' + p, { headers: { 'user-agent': UA }, signal: AbortSignal.timeout(20000) });
            if (!r.ok) continue;
            const post = parsePostPage(await r.text());
            if (!post.video) { st.seen[id] = 'no-video'; continue; }
            consider(st, t, topic, ch, { id, title: post.title || ch.title, published: post.published, url: post.video, channel: ch.title }, now, chFirst, rank++);
          }
          row.lastOk = new Date(now).toISOString(); row.error = null; row.latest = posts.length ? 'post ' + posts[0] : null;
          continue;
        }
        const ids = await channelIds(ch, st, row, deps, now);
        row.ids = ids;
        if (!ids.length) { row.error = 'channel not found'; continue; }
        for (const id of ids) {
          const r = await deps.fetch(feedUrl(id), { headers: { 'user-agent': UA }, signal: AbortSignal.timeout(20000) });
          if (!r.ok) throw new Error('feed HTTP ' + r.status);
          const feed = parseFeed(await r.text());
          (row.feedTitles ||= {})[id] = feed.channelTitle;
          row.lastOk = new Date(now).toISOString(); row.error = null; row.latest = feed.items[0]?.title || null;
          const items = [...feed.items].sort((x, y) => (Date.parse(y.published) || 0) - (Date.parse(x.published) || 0));
          items.forEach((it, rank) => consider(st, t, topic, ch, { id: it.videoId, title: it.title, published: it.published, short: it.short, channel: feed.channelTitle }, now, chFirst, rank));
        }
        if (ids.length) st.chStarted[chMark] = new Date(now).toISOString();
      } catch (e) { row.error = String(e?.message || e).slice(0, 120); }
    }
    if (firstRun) st.topicStarted[t] = new Date(now).toISOString();
  }
  // Keep the seen list bounded.
  const seen = Object.entries(st.seen);
  if (seen.length > 8000) st.seen = Object.fromEntries(seen.slice(-6000));
  saveState(st);
  status.lastPoll = new Date(now).toISOString();
  status.queue = Object.entries(st.queue).map(([v, q]) => ({ id: v, topic: topicOf(q), ch: q.ch, title: q.title?.slice(0, 80), tries: q.tries, wait: q.wait || null }));
  return Object.keys(st.queue).length;
}

// ---- The index of what is in Yemot (one per topic) ----
const indexOf = t => (TOPICS[t] || TOPICS['1']).index;
// Owner, 28.11 ("8 says there are no details"): reading a list from Yemot can
// fail for a moment when the system is busy. That used to count as "no list"
// - an empty list - so the key 8 lookup found nothing (and a write after such
// a read could have lost the list). Now: a missing list is new and empty; a
// failed read is tried again, and if it still fails it is an error, never an
// empty list. The last good copy of each list is kept for key 8.
const lastGood = new Map();
export async function readIndex(io, t = '1') {
  let last = null;
  for (const w of io.indexRetryWaits || [0, 700, 2000, 5000]) {
    if (w) await new Promise(r => setTimeout(r, w));
    try {
      const j = await io.readJson(indexOf(t));
      const idx = j || { version: 1, next: 0, items: {}, archives: 0 };
      if (j) lastGood.set(t, { at: Date.now(), idx });
      return j ? structuredClone(idx) : idx;
    } catch (e) { last = e; }
  }
  throw Object.assign(new Error('list of ' + t + ' not readable: ' + String(last?.message || last).slice(0, 80)), { code: 'index_unreadable' });
}
// For key 8 and the menus only (never for a write): the list, or its last good copy.
export async function readIndexForLookup(io, t = '1') {
  try { return await readIndex(io, t); }
  catch (e) { const g = lastGood.get(t); if (g) return structuredClone(g.idx); throw e; }
}
const rememberIndex = (t, idx) => lastGood.set(t, { at: Date.now(), idx: structuredClone(idx) });
let chain = Promise.resolve();
const serial = fn => { const j = chain.then(fn); chain = j.catch(() => {}); return j; };

// Lookup for keys 8/9/2: which video a file in /11 is.
export async function lookupNews(dir, file, io) {
  dir = String(dir || '').replace(/\/$/, '');
  const where = topicOfDir(dir);
  if (!where) return null;
  const idx = await readIndexForLookup(io, where.t);
  for (const [id, e] of Object.entries(idx.items || {})) if (e.dir === dir && e.file === String(file)) {
    return e.src === 'url' ? { videoId: null, url: e.url || null, title: e.title || '', dub: false, channel: e.ytChannel || e.chTitle || '' }
      : { videoId: id, title: e.title || '', dub: false, channel: e.ytChannel || e.chTitle || '' };
  }
  return null;
}

// Key 2 (confirmed): the file is deleted from Yemot and from the index. The
// answer is where to play next: the next older file, else the next newer one.
export function deleteNews(dir, file, io) {
  return serial(async () => {
    dir = String(dir || '').replace(/\/$/, '');
    const where = topicOfDir(dir);
    if (!where || !/^\d{3}$/.test(String(file))) throw new Error('not a news file');
    await io.del('ivr2:' + dir + '/' + file + '.wav');
    const idx = await readIndex(io, where.t);
    let videoId = null;
    for (const [v, e] of Object.entries(idx.items || {})) if (e.dir === dir && e.file === String(file)) videoId = v;
    if (videoId) { delete idx.items[videoId]; await io.writeJson(indexOf(where.t), idx); rememberIndex(where.t, idx); }
    const nums = Object.values(idx.items || {}).filter(e => e.dir === dir).map(e => Number(e.file)).sort((a, b) => a - b);
    const n = Number(file);
    const older = nums.filter(x => x < n).pop();
    const newer = nums.find(x => x > n);
    note({ deleted: dir + '/' + file, videoId });
    return { next: older !== undefined ? file3(older) : newer !== undefined ? file3(newer) : null, videoId };
  });
}

// A topic folder full: files 000-499 go to its next archive folder (same
// numbers, inside the topic), and 500-999 move down to 000-499.
export async function rotate(io, idx, t = '1') {
  // News (owner, 27.11): the oldest half is deleted, nothing is archived.
  if (TOPICS[t]?.news) {
    const dir = topicDir(t), half = MAX_FILES / 2;
    status.rotation = { at: new Date().toISOString(), to: 'deleted', state: 'running' };
    for (let n = 0; n < half; n++) await io.del('ivr2:' + dir + '/' + file3(n) + '.wav').catch(() => {});
    for (let n = half; n < MAX_FILES; n++) await io.move('ivr2:' + dir + '/' + file3(n) + '.wav', 'ivr2:' + dir + '/' + file3(n - half) + '.wav').catch(() => {});
    for (const [v, e] of Object.entries(idx.items || {})) {
      if (e.dir !== dir) continue;
      const n = Number(e.file);
      if (n < half) delete idx.items[v]; else e.file = file3(n - half);
    }
    idx.next = Math.max(0, (idx.next || MAX_FILES) - half);
    await io.writeJson(indexOf(t), idx); rememberIndex(t, idx);
    status.rotation.state = 'done';
    note({ rotated: dir, dropped: half });
    return idx;
  }
  const a = (idx.archives || 0) + FIRST_ARCHIVE;
  if (a > LAST_ARCHIVE) throw Object.assign(new Error('all archive folders are full'), { code: 'news_full' });
  const dir = topicDir(t), target = archiveDir(t, a);
  status.rotation = { at: new Date().toISOString(), to: target, state: 'running' };
  await io.saveSettings(target, playIni(io.publicUrl, target, 'ארכיון ' + TOPICS[t].title + ' ' + a));
  const half = MAX_FILES / 2;
  for (let n = 0; n < half; n++) await io.move('ivr2:' + dir + '/' + file3(n) + '.wav', 'ivr2:' + target + '/' + file3(n) + '.wav').catch(() => {});
  for (let n = half; n < MAX_FILES; n++) await io.move('ivr2:' + dir + '/' + file3(n) + '.wav', 'ivr2:' + dir + '/' + file3(n - half) + '.wav').catch(() => {});
  for (const e of Object.values(idx.items || {})) {
    if (e.dir !== dir) continue;
    const n = Number(e.file);
    if (n < half) e.dir = target; else e.file = file3(n - half);
  }
  idx.archives = a - FIRST_ARCHIVE + 1;
  idx.next = Math.max(0, (idx.next || MAX_FILES) - half);
  await io.writeJson(indexOf(t), idx); rememberIndex(t, idx);
  status.rotation.state = 'done';
  note({ rotated: target });
  return idx;
}

// Uploads one prepared phone file under the next number of its topic folder.
export function publishNews(videoId, wav, meta, io) {
  const t = TOPICS[meta?.topic] ? String(meta.topic) : '1';
  const dir = topicDir(t);
  return serial(async () => {
    let idx = await readIndex(io, t);
    if (idx.items?.[videoId]) return idx.items[videoId];
    if ((idx.next || 0) >= MAX_FILES) idx = await rotate(io, idx, t);
    const n = idx.next || 0;
    const file = file3(n);
    // The number is reserved first: a failure leaves a gap, never two on one.
    idx.next = n + 1;
    await io.writeJson(indexOf(t), idx); rememberIndex(t, idx);
    await io.saveSettings(dir, playIni(io.publicUrl, dir, TOPICS[t].title));
    let last = null;
    for (const w of io.retryWaits || [0, 15000, 45000, 120000]) {
      if (w) await new Promise(r => setTimeout(r, w));
      try { await io.upload(wav, 'ivr2:' + dir + '/' + file + '.wav'); last = null; break; }
      catch (e) { last = e; }
    }
    if (last) throw last;
    const fresh = await readIndex(io, t);
    fresh.next = Math.max(fresh.next || 0, n + 1);
    fresh.items = { ...(fresh.items || {}), [videoId]: { dir, file, title: String(meta.title || '').slice(0, 160), ch: meta.ch, chTitle: meta.chTitle, ytChannel: meta.ytChannel || null, published: meta.published, at: new Date().toISOString(), minutes: meta.minutes, ...(meta.url ? { src: 'url', url: meta.url } : {}) } };
    await io.writeJson(indexOf(t), fresh); rememberIndex(t, fresh);
    return fresh.items[videoId];
  });
}

// ---- Live check (yt-dlp, no download) ----
export function parseProbe(out) {
  const line = String(out || '').trim().split('\n').filter(Boolean).pop() || '';
  const [live, dur] = line.split('|');
  return { live: live || 'unknown', durationSec: Number(dur) > 0 ? Number(dur) : null };
}
export function probeVideo(videoId, bin, timeoutMs = 60000) {
  return new Promise(resolve => {
    const p = spawn(bin, ['--skip-download', '--no-warnings', '--no-playlist', '--print', '%(live_status)s|%(duration)s', 'https://www.youtube.com/watch?v=' + videoId], { stdio: ['ignore', 'pipe', 'pipe'] });
    let o = '', e = '';
    const t = setTimeout(() => p.kill('SIGKILL'), timeoutMs);
    p.stdout.on('data', d => { o += d; }); p.stderr.on('data', d => { e = (e + d).slice(-400); });
    p.on('error', () => { clearTimeout(t); resolve({ live: 'error', error: 'yt-dlp not runnable' }); });
    // A broadcast that has not started yet is an error for yt-dlp ("This live
    // event will begin in a few moments", "Premieres in 10 minutes"): it waits.
    p.on('close', c => { clearTimeout(t); const err = e.trim().split('\n').pop()?.slice(0, 160) || 'exit ' + c;
      resolve(c === 0 ? parseProbe(o) : /live event will begin|premieres? in|will begin in|is_upcoming|scheduled to start/i.test(e) ? { live: 'is_upcoming', error: err } : { live: 'error', error: err }); });
  });
}

// ---- The worker: the news has two lanes of its own (a 4-hour Knesset
// session never holds up a one-minute news item); the other topics share one
// more lane, and wait while the server is busy, so news and calls come first.
const LONG_SEC = 20 * 60;
const busy = { short: false, long: false, other: false };
export function serverBusy(load = os.loadavg()[0], freeMB = os.freemem() / 1048576) { return load > Number(process.env.NEWS11_MAX_LOAD || 3) || freeMB < Number(process.env.NEWS11_MIN_FREE_MB || 450); }
export async function workOnce(deps, now = Date.now()) {
  const st = loadState(); st.queue ||= {}; st.seen ||= {};
  const due = Object.entries(st.queue).filter(([, q]) => (q.nextAt || 0) <= now)
    // 27.11 (owner: the news always up to date): the newest video first.
    // Before, the oldest went first, so a week-old backlog of a newly added
    // channel held back the fresh news for hours.
    .sort((a, b) => (TOPICS[topicOf(a[1])].priority - TOPICS[topicOf(b[1])].priority) || ((Date.parse(b[1].published) || 0) - (Date.parse(a[1].published) || 0)));
  const started = [];
  const tooBusy = (deps.busy || serverBusy)();
  const day = new Date(now).toISOString().slice(0, 10);
  for (const [videoId, q] of due) {
    if (status.working[videoId]) continue;
    const t = topicOf(q);
    // LobbyTube: a video still waiting after its age limit is let go, and a
    // topic takes at most its daily number of files.
    if (q.lobby && now - (Date.parse(q.published) || now) > (q.maxAgeDays || 3) * 2 * 86400e3) { update(videoId, s2 => { delete s2.queue[videoId]; s2.seen[videoId] = 'old'; }); continue; }
    if (q.lobby && ((st.perDay || {})[day + ':' + t] || 0) >= (TOPICS[t].perDay || LOBBY_PER_DAY)) continue;
    // The owner's chosen Torah channels (11/2/1) have a lane of their own, so
    // they never wait behind the LobbyTube topics or a dubbing.
    const lane = TOPICS[t].ownLane ? 'own' + t : !TOPICS[t].news || q.dub ? 'other' : q.durationSec && q.durationSec > LONG_SEC ? 'long' : 'short';
    if (busy[lane] || (lane === 'other' && tooBusy)) continue;
    busy[lane] = true; status.working[videoId] = { lane, topic: t, since: new Date().toISOString(), title: q.title?.slice(0, 80) };
    started.push(runOne(videoId, q, lane, deps).finally(() => { busy[lane] = false; delete status.working[videoId]; }));
  }
  // Not awaited by the timer: a long job never stops new short ones starting.
  return { count: started.length, done: Promise.all(started) };
}

function update(videoId, fn) { const st = loadState(); st.queue ||= {}; st.seen ||= {}; fn(st); saveState(st); }
const retryLater = (videoId, mins, why, extra = {}) => update(videoId, st => { const q = st.queue[videoId]; if (!q) return; Object.assign(q, extra); q.tries = (q.tries || 0) + 1; q.wait = why; q.nextAt = Date.now() + mins * 60000; });

async function runOne(videoId, q, lane, deps) {
  const log = deps.log || console;
  const t = topicOf(q);
  const fromSite = q.src === 'url' && q.url;
  // 1. Is it a broadcast still on the air (or not started)? Then later.
  const pr = fromSite ? { live: 'not_live', durationSec: null } : await deps.probe(videoId);
  if (pr.durationSec) update(videoId, st => { if (st.queue[videoId]) st.queue[videoId].durationSec = pr.durationSec; });
  if (['is_live', 'is_upcoming', 'post_live'].includes(pr.live)) {
    const age = Date.now() - (Date.parse(q.published) || Date.now());
    if (age > 3 * 86400e3) { update(videoId, st => { delete st.queue[videoId]; st.seen[videoId] = 'live-too-long'; }); return; }
    retryLater(videoId, 10, pr.live); return;
  }
  if (pr.live === 'error') {
    if ((q.tries || 0) >= 12) { update(videoId, st => { delete st.queue[videoId]; st.seen[videoId] = 'unavailable'; }); note({ gaveUp: videoId, why: pr.error }); return; }
    retryLater(videoId, Math.min(60, 5 * 2 ** Math.min(4, q.tries || 0)), 'check failed: ' + (pr.error || '')); return;
  }
  // A long news item that came to the short lane goes to the long lane (next round).
  if (lane === 'short' && pr.durationSec > LONG_SEC) { update(videoId, st => { if (st.queue[videoId]) st.queue[videoId].nextAt = 0; }); return; }
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'news11-'));
  const t0 = Date.now();
  try {
    const src = path.join(tmp, 'source');
    if (fromSite) await deps.downloadUrl(q.url, src); else await deps.download(videoId, src);
    let title = q.title, sound = src;
    // Owner, 27.11: an English channel is heard in spoken Hebrew (the
    // original sound stays low underneath). Already Hebrew: as it is.
    if (q.dub && deps.dub) {
      const d = await deps.dub(src, path.join(tmp, 'dub.m4a'), q.title);
      if (d?.file) { sound = d.file; title = q.title + ' - מתורגם לעברית'; }
      else if (d?.state !== 'already_hebrew' && d?.state !== 'no_speech') throw new Error('dubbing failed: ' + (d?.state || 'unknown'));
    }
    const wav = path.join(tmp, 'phone.wav');
    const m = await deps.master(sound, wav, title, TOPICS[t].kind);
    await fs.rm(src, { force: true }).catch(() => {});
    const entry = await deps.publish(videoId, wav, { topic: t, title, ch: q.ch, chTitle: q.chTitle, ytChannel: q.ytChannel, published: q.published, url: fromSite ? q.url : null, minutes: Math.round((m?.durationSec || pr.durationSec || 0) / 60) });
    update(videoId, st => { delete st.queue[videoId]; st.seen[videoId] = 'done'; if (q.lobby) { st.perDay ||= {}; const k = new Date().toISOString().slice(0, 10) + ':' + t; st.perDay[k] = (st.perDay[k] || 0) + 1; for (const d of Object.keys(st.perDay)) if (d < new Date(Date.now() - 3 * 86400e3).toISOString().slice(0, 10)) delete st.perDay[d]; } });
    note({ done: videoId, topic: t, ch: q.ch, file: entry?.file, title: q.title?.slice(0, 80), seconds: Math.round((Date.now() - t0) / 1000), lateMin: Math.round((Date.now() - (Date.parse(q.published) || Date.now())) / 60000) });
    log.info?.('[NEWS11] published', { videoId, topic: t, ch: q.ch, file: entry?.file });
  } catch (e) {
    const msg = String(e?.message || e).slice(0, 200);
    note({ failed: videoId, topic: t, ch: q.ch, error: msg });
    log.warn?.('[NEWS11] not published; tried again later', { videoId, topic: t, message: msg });
    if ((q.tries || 0) >= 8) update(videoId, st => { delete st.queue[videoId]; st.seen[videoId] = 'failed'; });
    else retryLater(videoId, Math.min(120, 5 * 2 ** Math.min(5, q.tries || 0)), 'failed: ' + msg.slice(0, 80));
  } finally { await fs.rm(tmp, { recursive: true, force: true }).catch(() => {}); }
}

export function _resetForTests() { busy.short = busy.long = busy.other = false; status.working = {}; status.log.length = 0; chain = Promise.resolve(); }

// The LobbyTube topics, as saved last time.
loadLobby();
