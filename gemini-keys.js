// Gemini keys: the comma list GEMINI_API_KEYS (or GEMINI_API_KEY), then any
// extra keys in their own fields GEMINI_API_KEY_2 ... GEMINI_API_KEY_9.
export function geminiKeysFrom(env = process.env) {
  return [...new Set([
    ...String(env.GEMINI_API_KEYS || env.GEMINI_API_KEY || '').split(','),
    ...[2, 3, 4, 5, 6, 7, 8, 9].map(n => env['GEMINI_API_KEY_' + n] || '')
  ].map(k => String(k).trim()).filter(Boolean))];
}
