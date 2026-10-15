const DEFAULT_COOLDOWN_MS = 60_000;
const AUTH_COOLDOWN_MS = 10 * 60_000;

function makeProviderError(message, status, provider, extra = {}) {
  return Object.assign(new Error(message), { status, provider, ...extra });
}

/**
 * Minimal OpenAI-compatible chat-completions client for isolated Branch 1 fallbacks.
 * No SDK dependency is required. Callers must provide a text-only prompt; this helper
 * deliberately does not handle image, audio, video, or web-search grounding.
 */
export async function callCompatibleChatCompletion({
  provider,
  baseUrl,
  apiKey,
  model,
  messages,
  timeoutMs = 4500,
  maxTokens = 900,
  fetchImpl = globalThis.fetch,
  cooldowns = new Map(),
  now = Date.now,
  cooldownMs = DEFAULT_COOLDOWN_MS
}) {
  if (!apiKey || !model || !baseUrl || !Array.isArray(messages) || !messages.length) {
    throw makeProviderError(provider + ' fallback is not configured', 400, provider);
  }

  const coolingUntil = cooldowns.get(provider) || 0;
  if (coolingUntil > now()) {
    throw makeProviderError(provider + ' fallback cooling down after a recent provider failure', 429, provider, {
      coolingDown: true,
      retryAfterMs: coolingUntil - now()
    });
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), Math.max(250, Number(timeoutMs) || 4500));
  const endpoint = String(baseUrl).replace(/\\/+$/, '') + '/chat/completions';

  try {
    let response;
    try {
      response = await fetchImpl(endpoint, {
        method: 'POST',
        headers: {
          Authorization: 'Bearer ' + apiKey,
          'Content-Type': 'application/json',
          ...(provider === 'OpenRouter' ? {
            'HTTP-Referer': 'https://yemot-gemini-server.onrender.com',
            'X-Title': 'Yemot AI Phone Line'
          } : {})
        },
        body: JSON.stringify({
          model,
          messages,
          max_tokens: Math.max(128, Number(maxTokens) || 900),
          stream: false
        }),
        signal: controller.signal
      });
    } catch (error) {
      if (controller.signal.aborted || error?.name === 'AbortError') {
        cooldowns.set(provider, now() + cooldownMs);
        throw makeProviderError(provider + ' request timed out', 408, provider, { cause: error });
      }
      throw makeProviderError(provider + ' network request failed: ' + String(error?.message || error).slice(0, 180), 502, provider, { cause: error });
    }

    if (!response?.ok) {
      let detail = '';
      try { detail = String(await response.text()).slice(0, 240); } catch {}
      const status = Number(response?.status) || 502;
      if ([408, 429, 500, 502, 503, 504].includes(status)) {
        cooldowns.set(provider, now() + cooldownMs);
      } else if ([401, 403].includes(status)) {
        // Avoid sending the same invalid/revoked credential on every phone turn.
        cooldowns.set(provider, now() + AUTH_COOLDOWN_MS);
      }
      throw makeProviderError(provider + ' HTTP ' + status + (detail ? ': ' + detail : ''), status, provider);
    }

    let data;
    try {
      data = await response.json();
    } catch (error) {
      throw makeProviderError(provider + ' returned invalid JSON', 502, provider, { cause: error });
    }
    const answer = data?.choices?.[0]?.message?.content;
    if (typeof answer !== 'string' || !answer.trim()) {
      throw makeProviderError(provider + ' returned an empty answer', 502, provider);
    }

    cooldowns.delete(provider);
    return answer.trim();
  } finally {
    clearTimeout(timer);
  }
}
