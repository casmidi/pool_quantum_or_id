import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { log } from "../logger.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const STATE_PATH = path.join(__dirname, "..", "copy-signals.json");

const DEFAULT_STATE = {
  signals: [],
  ignored: [],
  meta: {
    lastRun: null,
    totalRuns: 0,
  },
};

let _cache = null;

function load() {
  if (_cache) return _cache;
  try {
    _cache = JSON.parse(fs.readFileSync(STATE_PATH, "utf8"));
  } catch {
    _cache = structuredClone(DEFAULT_STATE);
  }
  if (!Array.isArray(_cache.signals)) _cache.signals = [];
  if (!Array.isArray(_cache.ignored)) _cache.ignored = [];
  if (!_cache.meta) _cache.meta = {};
  return _cache;
}

function save() {
  try {
    fs.writeFileSync(STATE_PATH, JSON.stringify(_cache, null, 2), "utf8");
  } catch (err) {
    log("copy_state", `Save failed: ${err.message}`);
  }
}

export function getCopyState() {
  return load();
}

export function getRecentCopySignals({ limit = 20, action = null } = {}) {
  const state = load();
  return state.signals
    .filter((s) => !action || s.action === action)
    .slice()
    .sort((a, b) => new Date(b.ts || 0) - new Date(a.ts || 0))
    .slice(0, limit);
}

export function hasRecentCopySignal({ wallet, position, pool, ttlMs }) {
  const state = load();
  const now = Date.now();
  return state.signals.some((signal) => {
    const ts = new Date(signal.ts || 0).getTime();
    if (!Number.isFinite(ts) || now - ts > ttlMs) return false;
    return (
      (position && signal.position === position) ||
      (wallet && pool && signal.wallet === wallet && signal.pool === pool)
    );
  });
}

export function recordCopySignal(signal) {
  const state = load();
  state.signals.push({
    ...signal,
    ts: signal.ts || new Date().toISOString(),
  });
  if (state.signals.length > 500) {
    state.signals = state.signals.slice(-500);
  }
  save();
  return signal;
}

export function recordIgnoredCopySignal(signal) {
  const state = load();
  state.ignored.push({
    ...signal,
    ts: signal.ts || new Date().toISOString(),
  });
  if (state.ignored.length > 500) {
    state.ignored = state.ignored.slice(-500);
  }
  save();
  return signal;
}

export function touchCopyRun(summary = {}) {
  const state = load();
  state.meta.lastRun = new Date().toISOString();
  state.meta.totalRuns = Number(state.meta.totalRuns || 0) + 1;
  state.meta.lastSummary = summary;
  save();
  return state.meta;
}
