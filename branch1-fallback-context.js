/**
 * Build the prompt for Branch 1's independent text-only provider fallback.
 * Preserve the same Hebrew dialogue and behavior instructions as the primary model.
 */
export function buildBranch1FallbackMessages(systemInstruction, userText) {
  const messages = [];
  if (typeof systemInstruction === 'string' && systemInstruction.trim()) {
    messages.push({ role: 'system', content: systemInstruction.trim() });
  }
  if (typeof userText === 'string' && userText.trim()) {
    messages.push({ role: 'user', content: userText.trim() });
  }
  return messages;
}
