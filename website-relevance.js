const INTENT_PATTERNS = [
  { pattern: /שעות פתיחה|שעות פעילות|מתי פתוח|מתי נסגר|פתוח היום|פתוח עכשיו/i, terms: /שעות פתיחה|שעות פעילות|שעות קבלה|פתוח|נסגר|opening hours|business hours|opening times|\bhours\b/i, url: /hours|opening|שעות|סניפים|branches/i },
  { pattern: /טלפון|מספר טלפון|מוקד|יצירת קשר|צור קשר|דוא.?ל|אימייל/i, terms: /טלפון|מוקד|יצירת קשר|צור קשר|דוא.?ל|אימייל|contact us|contact details|phone|telephone|email/i, url: /contact|טלפון|צור.?קשר|יצירת.?קשר/i },
  { pattern: /כתובת|איך מגיעים|מיקום|מפה|דרכי הגעה/i, terms: /כתובת|מיקום|איך מגיעים|דרכי הגעה|address|location|directions/i, url: /location|address|מיקום|כתובת|סניפים|branches/i },
  { pattern: /מחיר|מחירים|עלות|תשלום|כרטיסים/i, terms: /מחיר|מחירים|עלות|תשלום|כרטיסים|price|pricing|cost|tickets/i, url: /price|pricing|ticket|מחיר|כרטיסים/i },
  { pattern: /שירותים|טיפולים|רופאים|מרפאה|סניפים|שירות/i, terms: /שירותים|טיפולים|רופאים|מרפאה|סניפים|שירות|services|clinics|branches/i, url: /service|clinic|branch|branches|סניפים|שירותים/i },
  { pattern: /אירוע|אירועים|הופעה|מופע|לוח אירועים|תאריך/i, terms: /אירוע|אירועים|הופעה|מופע|לוח אירועים|תאריך|events|calendar|schedule|tickets/i, url: /event|calendar|schedule|אירוע|לוח/i },
  { pattern: /אודות|מי אנחנו|על החברה|היסטוריה/i, terms: /אודות|מי אנחנו|על החברה|היסטוריה|about us|our story|company/i, url: /about|אודות|מי.?אנחנו/i }
];

function normalized(value) {
  return String(value || '').toLowerCase().replace(/[_/-]+/g, ' ').replace(/\s+/g, ' ').trim();
}
function normalizedUrl(value) {
  return normalized(String(value || '').replace(/[?#].*$/, ''));
}

/**
 * Rank extracted same-site pages by the actual information the caller requested.
 * The homepage is only a tie-breaker; it must not outrank a relevant contact,
 * hours, branches, or events page merely because it was the root URL.
 */
export function rankWebsitePages(question, pages, startUrl = '') {
  if (!Array.isArray(pages)) return [];
  const q = String(question || '');
  const normalizedQuestion = normalized(q);
  const intents = INTENT_PATTERNS.filter(item => item.pattern.test(q));
  const tokens = normalizedQuestion.split(/\s+/).filter(token =>
    token.length >= 3 && !/^(?:תפתח|פתח|תמשיך|תפרט|תרחיב|תסביר|בבקשה|באתר|האתר|אתר|עמוד|דף|תוכן|פרטים|מידע|אפשר|רוצה|לי|של|את|על|מה|איך|האם|איפה|כאן|שם|הזה|הזאת|הוא|היא|אני|תן|תביא|תקריא|תקרא)$/.test(token)
  );
  const root = normalizedUrl(startUrl).replace(/\/$/, '');
  return pages.map((page, index) => {
    const url = normalizedUrl(page?.url);
    const content = normalized(String(page?.content || '').slice(0, 9000));
    let score = 0;
    for (const intent of intents) {
      if (intent.terms.test(content)) score += 5;
      if (intent.url.test(url)) score += 8;
    }
    for (const token of tokens) {
      if (url.includes(token)) score += 3;
      if (content.includes(token)) score += 1;
    }
    const isRoot = url.replace(/\/$/, '') === root;
    if (isRoot) score += 0.5;
    return { page, score, index, isRoot };
  }).sort((a, b) => b.score - a.score || Number(b.isRoot) - Number(a.isRoot) || a.index - b.index)
    .map(item => item.page);
}
