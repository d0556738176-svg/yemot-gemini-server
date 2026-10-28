const DEFAULT_COOLDOWN_MS = 60_000;
const AUTH_COOLDOWN_MS = 10 * 60_000;
const QUOTA_COOLDOWN_MS = 90_000;

function retryAfterMs(response, now) {
  let value;
  try { value = response?.headers?.get?.('retry-after'); } catch {}
  if (!value) return 0;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.min(15 * 60_000, seconds * 1000);
  const date = Date.parse(value);
  return Number.isFinite(date) ? Math.min(15 * 60_000, Math.max(0, date - now())) : 0;
}

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
  cooldownMs = DEFAULT_COOLDOWN_MS,
  signal
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
  const abortFromParent = () => controller.abort();
  if(signal?.aborted) throw makeProviderError(provider + ' request cancelled',499,provider);
  signal?.addEventListener('abort',abortFromParent,{once:true});
  const timer = setTimeout(() => controller.abort(), Math.max(250, Number(timeoutMs) || 4500));
  const endpoint = String(baseUrl).replace(/\/+$/, '') + '/chat/completions';

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
          // gpt-oss models are reasoning models: low effort keeps answers fast and
          // stops hidden reasoning from consuming the whole token budget (empty reply).
          ...(provider === 'Groq' && /gpt-oss/i.test(String(model)) ? { reasoning_effort: 'low' } : {}),
          stream: false
        }),
        signal: controller.signal
      });
    } catch (error) {
      if(signal?.aborted) throw makeProviderError(provider + ' request cancelled',499,provider);
      if (controller.signal.aborted || error?.name === 'AbortError') {
        cooldowns.set(provider, now() + cooldownMs);
        throw makeProviderError(provider + ' request timed out', 408, provider, { cause: error });
      }
      cooldowns.set(provider, now() + cooldownMs);
      // Avoid copying arbitrary network error text into application logs.
      throw makeProviderError(provider + ' network request failed', 502, provider, { cause: error });
    }

    if (!response?.ok) {
      const status = Number(response?.status) || 502;
      // Drain the response body for connection reuse, but never log its contents.
      try { await response.text(); } catch {}
      if ([408, 500, 502, 503, 504].includes(status)) {
        cooldowns.set(provider, now() + cooldownMs);
      } else if ([402, 429].includes(status)) {
        // Quota/credit exhaustion: pause this provider and honor Retry-After when supplied.
        cooldowns.set(provider, now() + Math.max(QUOTA_COOLDOWN_MS, retryAfterMs(response, now)));
      } else if ([401, 403].includes(status)) {
        // Avoid sending the same invalid/revoked credential on every phone turn.
        cooldowns.set(provider, now() + AUTH_COOLDOWN_MS);
      }
      // Never log raw provider response bodies: they are unnecessary for routing and
      // could contain sensitive request/account details. Keep only provider + status.
      throw makeProviderError(provider + ' HTTP ' + status, status, provider);
    }

    let data;
    try {
      data = await response.json();
    } catch (error) {
      if(signal?.aborted) throw makeProviderError(provider + ' request cancelled',499,provider);
      cooldowns.set(provider, now() + cooldownMs);
      throw makeProviderError(provider + ' returned invalid JSON', 502, provider, { cause: error });
    }
    const answer = data?.choices?.[0]?.message?.content;
    if (typeof answer !== 'string' || !answer.trim()) {
      cooldowns.set(provider, now() + cooldownMs);
      throw makeProviderError(provider + ' returned an empty answer', 502, provider);
    }

    cooldowns.delete(provider);
    return answer.trim();
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort',abortFromParent);
  }
}

