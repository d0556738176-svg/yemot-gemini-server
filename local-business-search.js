const normalize = value => String(value || '')
  .toLowerCase()
  .replace(/[״׳]/g, "'")
  .replace(/[-־–—]/g, ' ')
  .replace(/[.,!?;:(){}]/g, ' ')
  .replace(/\s+/g, ' ')
  .trim();

const CITY_ALIASES = {
  'תל אביב': ['תל אביב', 'תל אביב יפו', 'תל אביב-יפו', 'תא', 'tel aviv'],
  'קריית גת': ['קריית גת', 'קרית גת', 'kiryat gat'],
  'קרית גת': ['קריית גת', 'קרית גת', 'kiryat gat'],
  'פתח תקווה': ['פתח תקווה', 'פתח תקוה', 'petah tikva']
};

export function isLocalBusinessDiscoveryRequest(question, location = {}) {
  const q = String(question || '');
  if (!location.area || !location.city) return false;
  if (/(?:שעות פתיחה|שעות פעילות|מתי פתוח|מתי נסגר|פתוח עכשיו|מספר טלפון|טלפון של|מוקד|שירות לקוחות)/i.test(q)) return false;
  return /(חנויות|חנות|עסקים|עסק|בתי עסק|מסעדות|מסעדה|מכולת|סופרמרקט|מרכז מסחרי|מקומות בשכונה|מה יש בשכונה|אילו מקומות)/i.test(q);
}

export function buildLocalBusinessQueries(question, { city = '', area = '' } = {}) {
  const q = String(question || '').replace(/\s+/g, ' ').trim();
  const category = /(מסעדות|מסעדה)/i.test(q) ? 'מסעדות' :
    /(מכולת|סופרמרקט|סופר)/i.test(q) ? 'מכולות וסופרמרקטים' :
    /(בתי מרקחת|בית מרקחת|פארם)/i.test(q) ? 'בתי מרקחת' : 'חנויות ועסקים';
  const location = [area, city].filter(Boolean).join(' ');
  const queries = [
    q,
    [category, area, city].filter(Boolean).join(' '),
    [category, 'בשכונת', area, city].filter(Boolean).join(' '),
    [area, city, 'עסקים חנויות כתובות'].filter(Boolean).join(' '),
    'site:easy.co.il ' + [category, area, city].filter(Boolean).join(' '),
    'site:d.co.il ' + [category, area, city].filter(Boolean).join(' ')
  ];
  return [...new Set(queries.map(x => x.trim()).filter(Boolean))].slice(0, 6);
}

function cityMatch(text, city) {
  if (!city) return true;
  const normalizedText = normalize(text);
  const candidates = CITY_ALIASES[city] || [city];
  return candidates.some(candidate => normalizedText.includes(normalize(candidate)));
}

export function filterLocalBusinessResults(results, { city = '', area = '' } = {}) {
  const normalizedArea = normalize(area).replace(/^(?:קניון|מתחם)\s+/, '').trim();
  if (!city || !normalizedArea) return [];
  return (Array.isArray(results) ? results : []).filter(result => {
    const haystack = normalize([result?.title, result?.snippet, result?.url].join(' '));
    // Strictly require both the requested locality and city. A nearby shopping
    // district is not evidence that a business is inside the requested neighborhood.
    return haystack.includes(normalizedArea) && cityMatch(haystack, city);
  });
}

export function buildNoVerifiedLocalResultsAnswer({ city = '', area = '' } = {}) {
  const location = [area, city].filter(Boolean).join(' ');
  return 'לא הצלחתי לאמת כרגע שמות של חנויות שנמצאות דווקא ב' + location +
    '. מצאתי או ייתכן שקיימים מקומות באזורים סמוכים, אבל לא אציג אותם כאילו הם בתוך השכונה שביקשת.';
}
