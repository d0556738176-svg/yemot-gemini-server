const CATEGORY_PATTERNS = [
  { name: 'security', pattern: /ביטחונ|ביטחון|צבא|צה.?ל|איראן|מלחמ|טילים|חמאס|חיזבאללה|פיגוע|טרור/i, query: 'חדשות ישראל ביטחון צבא היום' },
  { name: 'politics', pattern: /פוליטיק|כנסת|ממשלה|בחירות|ראש הממשלה|קואליציה|אופוזיציה/i, query: 'חדשות ישראל פוליטיקה כנסת ממשלה היום' },
  { name: 'technology', pattern: /טכנולוג|טכנולוגי|הייטק|בינה מלאכותית|ai|סייבר|מחשבים|סטארט.?אפ/i, query: 'חדשות טכנולוגיה בינה מלאכותית הייטק היום' },
  { name: 'health', pattern: /בריאות|בריאותי|רפוא|רפואה|בתי חולים|תרופות|מחקר רפואי/i, query: 'חדשות בריאות רפואה מחקרים היום' },
  { name: 'football', pattern: /כדורגל|ליגת העל|ליגת האלופות|מונדיאל|פיפ.?א|יורו|נבחרת ישראל/i, query: 'חדשות כדורגל תוצאות משחקים היום' },
  { name: 'sports', pattern: /ספורט|כדורסל|טניס|אולימפיאד|מרתון/i, query: 'חדשות ספורט היום' },
  { name: 'economy', pattern: /כלכל|בורסה|מניות|שוק ההון|ריבית|אינפלצי|מחירי דיור/i, query: 'חדשות כלכלה שוק ההון ישראל היום' },
  { name: 'world', pattern: /חדשות העולם|בעולם|בינלאומי|ארצות הברית|ארה.?ב|אירופה|אוקראינה|רוסיה|סין/i, query: 'חדשות בעולם היום' }
];

const NEWS_CUES = /חדשות|מבזק|כותרות|עדכונים|מה חדש|מה קורה|מה המצב|מה קרה|מה מתרחש|אקטואלי|אחרונות|סקירת חדשות|סקור חדשות|דיווחים אחרונים/i;

export function isNewsQuestion(transcript) {
  const q = String(transcript || '').trim();
  if (!q) return false;
  if (/(ערוץ\s*(?:14|12|13|11|c14)|c14\.co\.il|כאן חדשות|חדשות 12|חדשות 13|ynet|ווינט|וואלה חדשות|ישראל היום|מעריב)/i.test(q)) return true;
  const hasCategory = CATEGORY_PATTERNS.some(item => item.pattern.test(q));
  if (NEWS_CUES.test(q)) return true;
  return hasCategory && /(היום|עכשיו|כרגע|עדכון|אחרונ|מה חדש|מה קורה|מה המצב|סקור|סקירה|מה קרה)/i.test(q);
}

export function buildNewsSearchQueries(question, historyText = '') {
  const q = String(question || '').trim();
  const history = String(historyText || '').trim();
  const sourceMatch = q.match(/(?:ערוץ|חדשות|כותרות)\s*(14|c14|12|13|11)/i);
  if (sourceMatch) {
    const source = String(sourceMatch[1]).toUpperCase() === 'C14' ? 'ערוץ 14' : 'ערוץ ' + sourceMatch[1];
    const sourceQueries = {
      'ערוץ 14': 'site:c14.co.il חדשות היום',
      'ערוץ 12': 'site:mako.co.il/news חדשות היום',
      'ערוץ 13': 'site:13tv.co.il חדשות היום',
      'ערוץ 11': 'site:kan.org.il חדשות היום'
    };
    return [sourceQueries[source] || source + ' חדשות היום'];
  }

  const categories = CATEGORY_PATTERNS.filter(item => item.pattern.test(q));
  if (categories.length === 1) return [categories[0].query];
  if (categories.length > 1) return categories.slice(0, 4).map(item => item.query);

  const combined = (q + ' ' + history.slice(-500)).toLowerCase();
  if (/(כותרת|תוצאה|הפרט הראשון|הנושא הראשון|הראשונה|השני|השלישי)/i.test(q) && history) {
    const previousTitle = history.match(/(?:כותרת|תוצאה)\s*\d+\s*[:.]\s*([^\n.]+)/i)?.[1]?.trim();
    if (previousTitle) return [previousTitle.slice(0, 180)];
  }
  if (/(סקור|סקירה|כל התחומים|בכל התחומים|בכללי|באופן כללי|תמונת מצב|כל החדשות|חדשות היום|מה החדשות)/i.test(q) ||
      /(חדשות|מבזק|כותרות)/i.test(q)) {
    return [
      'חדשות ישראל ביטחון פוליטיקה היום',
      'חדשות טכנולוגיה בריאות בינה מלאכותית היום',
      'חדשות כדורגל ספורט כלכלה ועולם היום'
    ];
  }
  return [q.slice(0, 160) || combined.slice(0, 160)];
}
