/**
 * intelligence/rate-limiter.js
 * Token bucket rate limiter per provider.
 * Supports per-provider limits, burst, and graceful wait.
 */

import { log } from "../logger.js";

// ─── Bucket Store ─────────────────────────────────────────────

const buckets = new Map();

// ─── Default Limits (requests per minute) ─────────────────────

const DEFAULT_LIMITS = {
  gmgn:      { rpm: 30,  burst: 5 },
  dune:      { rpm: 10,  burst: 2 },
  helius:    { rpm: 100, burst: 10 },
  birdeye:   { rpm: 30,  burst: 5 },
  dexscreener: { rpm: 60, burst: 8 },
  tracklp:   { rpm: 20,  burst: 3 },
  fallback:  { rpm: 50,  burst: 10 },
};

// ─── Token Bucket ──────────────────────────────────────────────

class Bucket {
  constructor(provider, rpm, burst) {
    this.provider = provider;
    this.maxTokens = burst;
    this.tokens = burst;
    this.refillRate = rpm / 60; // tokens per second
    this.lastRefill = Date.now();
    this.waiting = [];
  }

  _refill() {
    const now = Date.now();
    const elapsed = (now - this.lastRefill) / 1000;
    this.tokens = Math.min(this.maxTokens, this.tokens + elapsed * this.refillRate);
    this.lastRefill = now;
  }

  /**
   * Try to consume a token. Returns true if allowed.
   */
  tryConsume() {
    this._refill();
    if (this.tokens >= 1) {
      this.tokens -= 1;
      return true;
    }
    return false;
  }

  /**
   * Wait until a token is available.
   * @param {number} timeoutMs — max wait time
   * @returns {Promise<boolean>} — true if token acquired
   */
  async waitForToken(timeoutMs = 10_000) {
    if (this.tryConsume()) return true;

    return new Promise((resolve) => {
      const start = Date.now();
      const check = () => {
        if (this.tryConsume()) {
          resolve(true);
          return;
        }
        if (Date.now() - start >= timeoutMs) {
          log("rate_limiter", `[${this.provider}] Timeout after ${timeoutMs}ms waiting for token`);
          resolve(false);
          return;
        }
        setTimeout(check, 100);
      };
      setTimeout(check, 100);
    });
  }

  get utilizationPct() {
    this._refill();
    return ((this.maxTokens - this.tokens) / this.maxTokens) * 100;
  }
}

// ─── Public API ────────────────────────────────────────────────

/**
 * Get or create a rate limiter bucket for a provider.
 * @param {string} provider — provider name (e.g. "gmgn", "helius")
 * @returns {Bucket}
 */
function getBucket(provider) {
  if (!buckets.has(provider)) {
    const limits = DEFAULT_LIMITS[provider] || DEFAULT_LIMITS.fallback;
    buckets.set(provider, new Bucket(provider, limits.rpm, limits.burst));
  }
  return buckets.get(provider);
}

/**
 * Rate-limited fetch wrapper.
 * Automatically waits for a token before executing the request.
 * 
 * @param {string} provider — provider name for rate limiting
 * @param {Function} fetcher — async () => response
 * @param {object} [opts]
 * @param {number} [opts.timeoutMs=10000] — max wait for rate limit
 * @param {number} [opts.retries=2] — retry on failure
 * @returns {Promise<any>}
 */
export async function rateLimitedFetch(provider, fetcher, opts = {}) {
  const timeout = opts.timeoutMs ?? 10_000;
  const retries = opts.retries ?? 2;
  const bucket = getBucket(provider);

  for (let attempt = 0; attempt <= retries; attempt++) {
    const gotToken = await bucket.waitForToken(timeout);
    if (!gotToken) {
      log("rate_limiter", `[${provider}] Rate limit busy, skipping request`);
      return null;
    }

    try {
      const result = await fetcher();
      return result;
    } catch (err) {
      if (err?.response?.status === 429) {
        // Server-side rate limit — back off
        const retryAfter = parseInt(err.response.headers?.["retry-after"] || "5", 10);
        log("rate_limiter", `[${provider}] 429 rate limited, waiting ${retryAfter}s`);
        await new Promise((r) => setTimeout(r, retryAfter * 1000));
        continue;
      }
      if (attempt < retries) {
        log("rate_limiter", `[${provider}] Attempt ${attempt + 1} failed: ${err.message}, retrying`);
        await new Promise((r) => setTimeout(r, 1000 * (attempt + 1)));
        continue;
      }
      throw err;
    }
  }
  return null;
}

/**
 * Get current utilization stats for all providers.
 */
export function getRateLimiterStats() {
  const stats = {};
  for (const [provider, bucket] of buckets) {
    stats[provider] = {
      utilizationPct: Math.round(bucket.utilizationPct * 10) / 10,
      tokensRemaining: Math.round(bucket.tokens * 10) / 10,
    };
  }
  return stats;
}

/**
 * Override default limits at runtime.
 * @param {object} customLimits — { provider: { rpm, burst } }
 */
export function configureRateLimits(customLimits = {}) {
  for (const [provider, limits] of Object.entries(customLimits)) {
    if (limits.rpm != null || limits.burst != null) {
      const existing = DEFAULT_LIMITS[provider] || { rpm: 30, burst: 5 };
      DEFAULT_LIMITS[provider] = {
        rpm: limits.rpm ?? existing.rpm,
        burst: limits.burst ?? existing.burst,
      };
      // Reset existing bucket if any
      if (buckets.has(provider)) {
        buckets.delete(provider);
      }
    }
  }
}
