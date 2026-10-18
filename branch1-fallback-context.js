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

/**
 * Flatten the role-separated messages for text-only APIs that accept one input string.
 * Label the system guidance explicitly so it cannot be mistaken for caller content.
 */
export function formatBranch1FallbackPrompt(systemInstruction, userText) {
  return buildBranch1FallbackMessages(systemInstruction, userText)
    .map(message => (message.role === 'system' ? 'System instructions:\\n' : 'Conversation:\\n') + message.content)
    .join('\\n\\n');
}
