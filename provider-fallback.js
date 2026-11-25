const DEFAULT_COOLDOWN_MS = 60_000;
const AUTH_COOLDOWN_MS = 10 * 60_000;
const QUOTA_COOLDOWN_MS = 90_000;
const EXHAUSTED_COOLDOWN_MS = 6 * 3600_000;

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
  onAttempt = null
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

  // Counted only when a request really goes out (not while cooling down).
  try { onAttempt?.(); } catch {}
  const controller = new AbortController();
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
          // Every Groq key slot (Groq2, Groq3 ...) and Cerebras too: 13.11 the
          // backup Groq keys ran gpt-oss-120b at the default effort and took ~8 s.
          ...(/^(?:Groq|Cerebras)/.test(String(provider)) && /gpt-oss/i.test(String(model)) ? { reasoning_effort: 'low' } : {}),
          stream: false
        }),
        signal: controller.signal
      });
    } catch (error) {
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
      let body = '';
      try { body = String(await response.text() || '').slice(0, 2000); } catch {}
      // 25.11: a trial key that used its monthly calls (Cohere 429 "Trial key ...
      // limited to 1000 API calls") or an account that now needs a payment method
      // (SambaNova 402) will not work again today: rest it for 6 hours instead of
      // trying it on every phone turn. Only this yes/no is kept, never the text.
      const exhausted = status === 402 || /trial key|limited to \d+ api calls|payment method|monthly limit|billing/i.test(body);
      if (exhausted) {
        cooldowns.set(provider, now() + EXHAUSTED_COOLDOWN_MS);
        throw makeProviderError(provider + ' HTTP ' + status + ' (quota or plan used up)', status, provider, { exhausted: true });
      }
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
  }
}
