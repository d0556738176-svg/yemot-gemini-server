const DEFAULT_QUOTA_COOLDOWN_MS = 120000;
const DEFAULT_TRANSIENT_COOLDOWN_MS = 25000;
const RETRYABLE_PROVIDER_STATUSES = new Set([429, 408, 500, 502, 503, 504]);

/**
 * Small in-memory cooldown registry for provider/model circuits.
 * It deliberately avoids timers: expired entries are removed when next checked.
 */
export function createCooldownRegistry({
  quotaMs = DEFAULT_QUOTA_COOLDOWN_MS,
  transientMs = DEFAULT_TRANSIENT_COOLDOWN_MS,
  now = () => Date.now()
} = {}) {
  const cooldowns = new Map();

  function remainingMs(key) {
    const id = String(key);
    const until = cooldowns.get(id) || 0;
    const remaining = until - now();
    if (remaining <= 0) {
      cooldowns.delete(id);
      return 0;
    }
    return remaining;
  }

  return {
    isCoolingDown(key) {
      return remainingMs(key) > 0;
    },
    remainingMs,
    cool(key, status) {
      const code = Number(status);
      if (!RETRYABLE_PROVIDER_STATUSES.has(code)) return 0;
      const duration = code === 429
        ? Math.max(1000, Number(quotaMs) || DEFAULT_QUOTA_COOLDOWN_MS)
        : Math.max(1000, Number(transientMs) || DEFAULT_TRANSIENT_COOLDOWN_MS);
      const id = String(key);
      const nextUntil = now() + duration;
      cooldowns.set(id, Math.max(cooldowns.get(id) || 0, nextUntil));
      return duration;
    },
    clear(key) {
      cooldowns.delete(String(key));
    },
    clearAll() {
      cooldowns.clear();
    }
  };
}
