/**
 * intelligence/cache-manager.js
 * In-memory + file TTL cache for provider data.
 * 
 * Tier 1: in-memory Map (fastest, process lifetime)
 * Tier 2: file-based JSON (survives restarts, bounded size)
 * 
 * File writes are debounced (batched per namespace, 2s interval)
 * to avoid blocking the event loop under rapid writes.
 */

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { log } from "../logger.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CACHE_DIR = path.join(__dirname, "..", ".cache");
const DEFAULT_TTL_MS = 5 * 60 * 1000; // 5 min
const MAX_FILE_CACHE_ENTRIES = 500;
const DEBOUNCE_MS = 2000; // batch writes within 2s window

// ─── In-Memory Tier ───────────────────────────────────────────

const mem = new Map();

// ─── File Tier — Debounced Write Queue ────────────────────────

/** Pending writes per namespace — { namespace: { key: { value, expiresAt, cachedAt } } } */
const pendingWrites = new Map();
const debounceTimers = new Map();

function filePath(namespace) {
  return path.join(CACHE_DIR, `${namespace}.json`);
}

function ensureDir() {
  if (!fs.existsSync(CACHE_DIR)) {
    fs.mkdirSync(CACHE_DIR, { recursive: true });
  }
}

function loadFile(namespace) {
  const fp = filePath(namespace);
  try {
    if (fs.existsSync(fp)) {
      const raw = fs.readFileSync(fp, "utf-8");
      return JSON.parse(raw);
    }
  } catch (err) {
    log("cache", `File load error [${namespace}]: ${err.message}`);
  }
  return {};
}

/**
 * Flush pending writes for a namespace to disk.
 * Prunes expired entries and enforces max entries.
 */
function flushNamespace(namespace) {
  if (!pendingWrites.has(namespace)) return;
  const pending = pendingWrites.get(namespace);
  pendingWrites.delete(namespace);

  ensureDir();
  const fp = filePath(namespace);
  try {
    // Merge pending into existing store
    const store = (fs.existsSync(fp))
      ? JSON.parse(fs.readFileSync(fp, "utf-8"))
      : {};
    for (const [key, entry] of pending) {
      store[key] = entry;
    }

    // Prune expired
    const now = Date.now();
    const clean = Object.fromEntries(
      Object.entries(store).filter(([, v]) => v.expiresAt > now)
    );

    // Enforce max entries — keep newest
    const entries = Object.entries(clean).sort((a, b) => b[1].cachedAt - a[1].cachedAt);
    const trimmed = Object.fromEntries(entries.slice(0, MAX_FILE_CACHE_ENTRIES));

    fs.writeFileSync(fp, JSON.stringify(trimmed, null, 2), "utf-8");
  } catch (err) {
    log("cache", `File flush error [${namespace}]: ${err.message}`);
  }
}

/**
 * Schedule a debounced file write for a namespace.
 * Multiple writes within DEBOUNCE_MS are batched.
 */
function scheduleFlush(namespace) {
  if (debounceTimers.has(namespace)) {
    clearTimeout(debounceTimers.get(namespace));
  }
  debounceTimers.set(namespace, setTimeout(() => {
    debounceTimers.delete(namespace);
    flushNamespace(namespace);
  }, DEBOUNCE_MS));
}

// ─── Public API ────────────────────────────────────────────────

/**
 * Get a cached value.
 * @param {string} key — cache key (e.g. "wallet:abc123_score")
 * @param {object} [opts]
 * @param {string} [opts.namespace="default"] — file namespace
 * @param {number} [opts.maxAgeMs] — override TTL
 * @returns {any|null} — cached value or null if expired/missing
 */
export function cacheGet(key, opts = {}) {
  const namespace = opts.namespace || "default";
  const maxAge = opts.maxAgeMs ?? DEFAULT_TTL_MS;
  const now = Date.now();

  // Tier 1: in-memory
  if (mem.has(key)) {
    const entry = mem.get(key);
    if (now < entry.expiresAt) {
      return entry.value;
    }
    mem.delete(key);
  }

  // Tier 2: file
  const store = loadFile(namespace);
  const entry = store[key];
  if (entry && now < entry.expiresAt) {
    // Promote to memory
    mem.set(key, { value: entry.value, expiresAt: entry.expiresAt });
    return entry.value;
  }

  return null;
}

/**
 * Set a cached value.
 * @param {string} key
 * @param {any} value
 * @param {object} [opts]
 * @param {string} [opts.namespace="default"]
 * @param {number} [opts.ttlMs] — TTL in ms
 */
export function cacheSet(key, value, opts = {}) {
  const namespace = opts.namespace || "default";
  const ttl = opts.ttlMs ?? DEFAULT_TTL_MS;
  const now = Date.now();
  const expiresAt = now + ttl;

  // In-memory (instant)
  mem.set(key, { value, expiresAt });

  // File (debounced batch write)
  if (!pendingWrites.has(namespace)) {
    pendingWrites.set(namespace, new Map());
  }
  pendingWrites.get(namespace).set(key, { value, expiresAt, cachedAt: now });
  scheduleFlush(namespace);
}

/**
 * Check if key exists and is fresh.
 */
export function cacheHas(key, opts = {}) {
  return cacheGet(key, opts) !== null;
}

/**
 * Invalidate specific key(s). Supports wildcard suffix with "*".
 * @param {string} key — exact key or prefix with "*" (e.g. "wallet:*")
 * @param {object} [opts]
 * @param {string} [opts.namespace="default"]
 */
export function cacheInvalidate(pattern, opts = {}) {
  const namespace = opts.namespace || "default";

  if (pattern.endsWith("*")) {
    const prefix = pattern.slice(0, -1);
    // Clear from memory
    for (const k of mem.keys()) {
      if (k.startsWith(prefix)) mem.delete(k);
    }
    // Clear from file + pending
    if (pendingWrites.has(namespace)) {
      for (const k of pendingWrites.get(namespace).keys()) {
        if (k.startsWith(prefix)) pendingWrites.get(namespace).delete(k);
      }
    }
    const store = loadFile(namespace);
    for (const k of Object.keys(store)) {
      if (k.startsWith(prefix)) {
        delete store[k];
        // Write immediately for invalidation (synchronous — rare operation)
        try {
          fs.writeFileSync(filePath(namespace), JSON.stringify(store, null, 2), "utf-8");
        } catch { /* ignore */ }
      }
    }
  } else {
    mem.delete(pattern);
    if (pendingWrites.has(namespace)) {
      pendingWrites.get(namespace).delete(pattern);
    }
    const store = loadFile(namespace);
    delete store[pattern];
    try {
      fs.writeFileSync(filePath(namespace), JSON.stringify(store, null, 2), "utf-8");
    } catch { /* ignore */ }
  }
}

/**
 * Clear entire cache (memory + file namespace).
 */
export function cacheClear(namespace = "default") {
  mem.clear();
  if (pendingWrites.has(namespace)) {
    pendingWrites.delete(namespace);
  }
  if (debounceTimers.has(namespace)) {
    clearTimeout(debounceTimers.get(namespace));
    debounceTimers.delete(namespace);
  }
  const fp = filePath(namespace);
  try {
    if (fs.existsSync(fp)) fs.unlinkSync(fp);
  } catch { /* ignore */ }
}

/**
 * Force-flush all pending writes to disk immediately.
 * Call before graceful shutdown.
 */
export async function cacheFlushAll() {
  const namespaces = Array.from(pendingWrites.keys());
  for (const ns of namespaces) {
    if (debounceTimers.has(ns)) {
      clearTimeout(debounceTimers.get(ns));
      debounceTimers.delete(ns);
    }
    flushNamespace(ns);
  }
}

/**
 * Wrap an async function with caching.
 * @param {string} key
 * @param {Function} fetcher — async () => value
 * @param {object} [opts] — same as cacheSet
 * @returns {Promise<any>}
 */
export async function cacheWrap(key, fetcher, opts = {}) {
  const cached = cacheGet(key, opts);
  if (cached !== null) return cached;

  const value = await fetcher();
  cacheSet(key, value, opts);
  return value;
}
