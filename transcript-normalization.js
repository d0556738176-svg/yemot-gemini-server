// Conservative, context-aware normalization of frequent Hebrew phone ASR variants.
// Keep this deterministic: do not rewrite arbitrary words or infer missing intent.
const RULES = [
  { pattern: /סופר\s*[-־]?\s*(?:פרם|פארם|פרום|פראם)/gi, replacement: 'סופר-פארם' },
  { pattern: /(?:ביויוטב|ביוטוב|ביוטיוב|יוטוב)/gi, replacement: 'יוטיוב' },
  { pattern: /בנק\s+דיווחון/gi, replacement: 'בנק דיסקונט' }
];

export function normalizeHebrewPhoneTranscript(input) {
  let text = String(input || '').normalize('NFKC')
    .replace(/[\u200e\u200f\u202a-\u202e]/g, '')
    .replace(/[\t\r\n]+/g, ' ')
    .replace(/\s{2,}/g, ' ')
    .trim();
  for (const rule of RULES) text = text.replace(rule.pattern, rule.replacement);
  return text;
}
