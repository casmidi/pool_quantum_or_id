import {
  Connection,
  Keypair,
  PublicKey,
  SystemInstruction,
  SystemProgram,
  Transaction,
  TransactionInstruction,
  VersionedTransaction,
  sendAndConfirmTransaction,
} from "@solana/web3.js";
import BN from "bn.js";
import bs58 from "bs58";
import { config, computeDeployAmount, MIN_SAFE_BINS_BELOW } from "../config.js";
import { log } from "../logger.js";
import {
  trackPosition,
  markOutOfRange,
  markInRange,
  recordClaim,
  recordClose,
  getTrackedPosition,
  minutesOutOfRange,
  syncOpenPositions,
} from "../state.js";
import { recordPerformance } from "../lessons.js";
import { isBaseMintOnCooldown, isPoolOnCooldown } from "../pool-memory.js";
import { normalizeMint, getWalletBalances } from "./wallet.js";
import { appendDecision } from "../decision-log.js";
import { agentMeridianJson, getAgentIdForRequests, getAgentMeridianHeaders } from "./agent-meridian.js";
import crypto from "crypto";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

// ─── Lazy SDK loader ───────────────────────────────────────────
// @meteora-ag/dlmm → @coral-xyz/anchor uses CJS directory imports
// that break in ESM on Node 24. Dynamic import defers loading until
// an actual on-chain call is needed (never triggered in dry-run).
let _DLMM = null;
let _StrategyType = null;
let _getBinIdFromPrice = null;
let _getPriceOfBinByBinId = null;
let _getBinArrayKeysCoverage = null;
let _getBinArrayIndexesCoverage = null;
let _deriveBinArrayBitmapExtension = null;
let _isOverflowDefaultBinArrayBitmap = null;
let _BIN_ARRAY_FEE = null;
let _BIN_ARRAY_BITMAP_FEE = null;

async function getDLMM() {
  if (!_DLMM) {
    const mod = await import("@meteora-ag/dlmm");
    _DLMM = mod.default;
    _StrategyType = mod.StrategyType;
    _getBinIdFromPrice = mod.default?.getBinIdFromPrice;
    _getPriceOfBinByBinId = mod.getPriceOfBinByBinId;
    _getBinArrayKeysCoverage = mod.getBinArrayKeysCoverage;
    _getBinArrayIndexesCoverage = mod.getBinArrayIndexesCoverage;
    _deriveBinArrayBitmapExtension = mod.deriveBinArrayBitmapExtension;
    _isOverflowDefaultBinArrayBitmap = mod.isOverflowDefaultBinArrayBitmap;
    _BIN_ARRAY_FEE = mod.BIN_ARRAY_FEE;
    _BIN_ARRAY_BITMAP_FEE = mod.BIN_ARRAY_BITMAP_FEE;
  }
  return {
    DLMM: _DLMM,
    StrategyType: _StrategyType,
    getBinIdFromPrice: _getBinIdFromPrice,
    getPriceOfBinByBinId: _getPriceOfBinByBinId,
    getBinArrayKeysCoverage: _getBinArrayKeysCoverage,
    getBinArrayIndexesCoverage: _getBinArrayIndexesCoverage,
    deriveBinArrayBitmapExtension: _deriveBinArrayBitmapExtension,
    isOverflowDefaultBinArrayBitmap: _isOverflowDefaultBinArrayBitmap,
    BIN_ARRAY_FEE: _BIN_ARRAY_FEE,
    BIN_ARRAY_BITMAP_FEE: _BIN_ARRAY_BITMAP_FEE,
  };
}

// ─── Lazy wallet/connection init ──────────────────────────────
// Avoids crashing on import when WALLET_PRIVATE_KEY is not yet set
// (e.g. during screening-only tests).
let _connection = null;
let _wallet = null;
let _rpcHealthCache = null;
let _rpcHealthCacheAt = 0;
let _rpcEndpointIndex = 0;
const _rpcConnections = new Map();

const RPC_HEALTH_TTL_MS = 15_000;
const RPC_HEALTH_TIMEOUT_MS = Number(process.env.RPC_HEALTH_TIMEOUT_MS || 8_000);
const TX_RECONCILE_DELAY_MS = Number(process.env.TX_RECONCILE_DELAY_MS || 5_000);
const TX_MIN_INTERVAL_MS = Number(process.env.DLMM_TX_MIN_INTERVAL_MS || 1_500);
const TX_VERIFY_COMMITMENT = process.env.DLMM_TX_VERIFY_COMMITMENT || "finalized";
let _nextTxSendAt = 0;
let _txRateLimitTail = Promise.resolve();

// P1: Per-API circuit breaker — opens after N consecutive failures, pauses for cooldown.
// Prevents hammering a degraded external API and avoids making decisions from stale/failed data.
const API_CIRCUIT_MAX_FAILURES = Number(process.env.API_CIRCUIT_MAX_FAILURES || 3);
const API_CIRCUIT_COOLDOWN_MS  = Number(process.env.API_CIRCUIT_COOLDOWN_MS  || 120_000); // 2 min
const _apiCircuit = new Map(); // name → { failures, pausedUntil }

function _apiCircuitCheck(name) {
  const s = _apiCircuit.get(name) || { failures: 0, pausedUntil: 0 };
  if (s.pausedUntil > Date.now()) {
    const secsLeft = Math.ceil((s.pausedUntil - Date.now()) / 1000);
    throw new Error(`${name} API circuit open — ${secsLeft}s cooldown remaining after ${s.failures} consecutive failures`);
  }
}

function _apiCircuitSuccess(name) {
  if (_apiCircuit.has(name)) _apiCircuit.set(name, { failures: 0, pausedUntil: 0 });
}

function _apiCircuitFailure(name) {
  const s = _apiCircuit.get(name) || { failures: 0, pausedUntil: 0 };
  const failures = s.failures + 1;
  if (failures >= API_CIRCUIT_MAX_FAILURES) {
    const pausedUntil = Date.now() + API_CIRCUIT_COOLDOWN_MS;
    _apiCircuit.set(name, { failures, pausedUntil });
    log("api_circuit_warn", `${name} circuit opened after ${failures} consecutive failures — pausing ${API_CIRCUIT_COOLDOWN_MS / 1000}s`);
  } else {
    _apiCircuit.set(name, { failures, pausedUntil: 0 });
    log("api_circuit_warn", `${name} failure ${failures}/${API_CIRCUIT_MAX_FAILURES}`);
  }
}

function envFlag(...names) {
  return names.some((name) => /^(1|true|yes|on)$/i.test(String(process.env[name] || "").trim()));
}

function getCircuitBreakerReason({ deployOnly = false } = {}) {
  if (envFlag("DLMM_EMERGENCY_HALT")) return "DLMM_EMERGENCY_HALT is enabled";
  if (deployOnly && envFlag("DLMM_PAUSE_DEPLOYS", "PAUSE_DEPLOYS")) return "deploy circuit breaker is enabled";
  return null;
}

function assertTransactionCircuitClosed(label) {
  if (process.env.DRY_RUN === "true") return;
  const reason = getCircuitBreakerReason();
  if (reason) {
    throw new Error(`Circuit breaker open before ${label}: ${reason}`);
  }
}

function assertDeployCircuitClosed(poolAddress) {
  if (process.env.DRY_RUN === "true") return;
  const reason = getCircuitBreakerReason({ deployOnly: true });
  if (reason) {
    throw new Error(`Deploy paused for ${poolAddress?.slice?.(0, 8) || "pool"}: ${reason}`);
  }
}

function getRpcEndpoints() {
  const endpoints = [
    process.env.RPC_URL,
    ...(process.env.RPC_FALLBACK_URLS || "")
      .split(",")
      .map((entry) => entry.trim())
      .filter(Boolean),
  ].filter(Boolean);
  return [...new Set(endpoints)];
}

function createRpcConnection(endpoint) {
  if (!_rpcConnections.has(endpoint)) {
    _rpcConnections.set(endpoint, new Connection(endpoint, "confirmed"));
  }
  return _rpcConnections.get(endpoint);
}

function getConnection() {
  const endpoints = getRpcEndpoints();
  if (endpoints.length === 0) {
    throw new Error("RPC_URL not set — cannot create Solana connection. Check your .env file.");
  }
  if (_rpcEndpointIndex >= endpoints.length) _rpcEndpointIndex = 0;
  const endpoint = endpoints[_rpcEndpointIndex];
  if (!_connection) _connection = createRpcConnection(endpoint);
  return _connection;
}

function switchRpcEndpoint(index, reason = "manual") {
  const endpoints = getRpcEndpoints();
  if (index < 0 || index >= endpoints.length) return false;
  if (index === _rpcEndpointIndex && _connection) return true;
  _rpcEndpointIndex = index;
  _connection = createRpcConnection(endpoints[_rpcEndpointIndex]);
  _rpcHealthCache = null;
  _rpcHealthCacheAt = 0;
  const endpointLabel = endpoints[_rpcEndpointIndex].replace(/\?.*$/, "?...");
  log("rpc_failover", `Using RPC endpoint ${_rpcEndpointIndex + 1}/${endpoints.length} (${reason}): ${endpointLabel}`);
  return true;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function withTimeout(promise, timeoutMs, label) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} timed out after ${timeoutMs}ms`)), timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function fetchJsonWithRetry(url, {
  label = "fetch",
  attempts = 3,
  timeoutMs = 5_000,
  backoffMs = 500,
} = {}) {
  let lastError;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetch(url, { signal: controller.signal });
      if (!res.ok) {
        const body = await res.text().catch(() => "");
        throw new Error(`${label} HTTP ${res.status}: ${body.slice(0, 160)}`);
      }
      return await res.json();
    } catch (error) {
      lastError = error;
      if (attempt < attempts) {
        log("fetch_retry", `${label} attempt ${attempt}/${attempts} failed: ${error.message}`);
        await sleep(backoffMs * attempt);
      }
    } finally {
      clearTimeout(timer);
    }
  }
  throw lastError;
}

async function waitForTxRateLimit(label) {
  if (process.env.DRY_RUN === "true") return;
  if (!Number.isFinite(TX_MIN_INTERVAL_MS) || TX_MIN_INTERVAL_MS <= 0) return;

  let release;
  const previous = _txRateLimitTail;
  _txRateLimitTail = new Promise((resolve) => { release = resolve; });
  await previous;
  try {
    const waitMs = Math.max(0, _nextTxSendAt - Date.now());
    if (waitMs > 0) {
      log("tx_rate_limit", `${label}: waiting ${waitMs}ms before next tx send`);
      await sleep(waitMs);
    }
    _nextTxSendAt = Date.now() + TX_MIN_INTERVAL_MS;
  } finally {
    release();
  }
}

// P1: Quality-scored RPC health check.
// Probes all endpoints in parallel, then picks the one with the highest confirmed slot.
// Ties are broken by lowest latency. Prevents defaulting to a slow or stale endpoint just
// because it responded first.
async function checkRpcHealth({ force = false, label = "rpc" } = {}) {
  const now = Date.now();
  if (!force && _rpcHealthCache && now - _rpcHealthCacheAt < RPC_HEALTH_TTL_MS) {
    return _rpcHealthCache;
  }

  const endpoints = getRpcEndpoints();
  if (endpoints.length === 0) {
    throw new Error("RPC_URL not set — cannot create Solana connection. Check your .env file.");
  }

  const probes = await Promise.allSettled(
    endpoints.map(async (endpoint, index) => {
      const started = Date.now();
      const connection = createRpcConnection(endpoint);
      const [slot, blockhash] = await withTimeout(
        Promise.all([
          connection.getSlot("confirmed"),
          connection.getLatestBlockhash("confirmed"),
        ]),
        RPC_HEALTH_TIMEOUT_MS,
        `${label} health check endpoint ${index + 1}`,
      );
      return { index, slot, blockhash, latency_ms: Date.now() - started };
    })
  );

  const healthy = probes
    .map((r, i) => (r.status === "fulfilled" ? r.value : null))
    .filter(Boolean);

  probes.forEach((r, i) => {
    if (r.status === "rejected") {
      log("rpc_health_warn", `${label}: endpoint ${i + 1}/${endpoints.length} failed: ${r.reason?.message}`);
    }
  });

  if (healthy.length === 0) {
    const failed = {
      ok: false,
      endpoint_index: _rpcEndpointIndex,
      endpoint_count: endpoints.length,
      error: "All RPC endpoints failed health check.",
      latency_ms: 0,
      checked_at: Date.now(),
    };
    _rpcHealthCache = failed;
    _rpcHealthCacheAt = Date.now();
    return _rpcHealthCache;
  }

  // Sort: highest slot first, then lowest latency
  healthy.sort((a, b) => b.slot - a.slot || a.latency_ms - b.latency_ms);
  const best = healthy[0];

  if (healthy.length > 1) {
    const slotSpread = healthy[0].slot - healthy[healthy.length - 1].slot;
    if (slotSpread > 5) {
      log("rpc_health", `Slot spread: ${slotSpread} slots across ${healthy.length} endpoints — using endpoint ${best.index + 1} (slot ${best.slot}, ${best.latency_ms}ms)`);
    }
  }

  if (best.index !== _rpcEndpointIndex || !_connection) {
    switchRpcEndpoint(best.index, healthy.length === 1 ? "only healthy endpoint" : "quality scoring");
  }

  _rpcHealthCache = {
    ok: true,
    endpoint_index: best.index,
    endpoint_count: endpoints.length,
    slot: best.slot,
    blockhash: best.blockhash?.blockhash || null,
    latency_ms: best.latency_ms,
    checked_at: Date.now(),
    endpoint_scores: healthy.map(h => ({ index: h.index, slot: h.slot, latency_ms: h.latency_ms })),
  };
  _rpcHealthCacheAt = Date.now();
  return _rpcHealthCache;
}

async function sendAndConfirmOnHealthyRpc(tx, signers, label) {
  assertTransactionCircuitClosed(label);
  const endpoints = getRpcEndpoints();
  const startIndex = _rpcEndpointIndex < endpoints.length ? _rpcEndpointIndex : 0;
  let lastError;

  for (let offset = 0; offset < endpoints.length; offset++) {
    const index = (startIndex + offset) % endpoints.length;
    try {
      switchRpcEndpoint(index, offset === 0 ? "tx preflight" : "tx preflight retry");
      await assertRpcHealthy(`${label}:rpc${index + 1}`);
      await waitForTxRateLimit(label);
      return await sendAndConfirmTransaction(getConnection(), tx, signers);
    } catch (error) {
      lastError = error;
      _rpcHealthCache = null;
      _rpcHealthCacheAt = 0;
      log("rpc_failover", `${label}: endpoint ${index + 1}/${endpoints.length} failed: ${error.message}`);
      if (!/RPC unhealthy before/i.test(error.message)) break;
      if (endpoints.length <= 1) break;
    }
  }

  throw lastError;
}

async function assertRpcHealthy(label) {
  if (process.env.DRY_RUN === "true") return;
  const health = await checkRpcHealth({ label });
  if (!health.ok) {
    throw new Error(`RPC unhealthy before ${label}: ${health.error}`);
  }
}

function getWallet() {
  if (!_wallet) {
    if (!process.env.WALLET_PRIVATE_KEY) {
      throw new Error("WALLET_PRIVATE_KEY not set");
    }
    _wallet = Keypair.fromSecretKey(bs58.decode(process.env.WALLET_PRIVATE_KEY));
    log("init", `Wallet: ${_wallet.publicKey.toString()}`);
  }
  return _wallet;
}

function shouldUseLpAgentRelay() {
  return !!config.api.lpAgentRelayEnabled;
}

function shouldUseLpAgentRelayForDeploy() {
  // Zap-in relay is intentionally disabled; deploys use the local Meteora SDK path.
  return false;
}

function signSerializedTransaction(serialized, wallet) {
  const bytes = Buffer.from(serialized, "base64");
  try {
    const versioned = VersionedTransaction.deserialize(bytes);
    versioned.sign([wallet]);
    return Buffer.from(versioned.serialize()).toString("base64");
  } catch {
    const legacy = Transaction.from(bytes);
    legacy.partialSign(wallet);
    return legacy
      .serialize({ requireAllSignatures: false, verifySignatures: false })
      .toString("base64");
  }
}

function deserializeSignedTransaction(signedBase64) {
  const bytes = Buffer.from(signedBase64, "base64");
  try {
    return VersionedTransaction.deserialize(bytes);
  } catch {
    return Transaction.from(bytes);
  }
}

function getStaticAccountKeyStrings(tx) {
  if (tx instanceof VersionedTransaction) {
    return tx.message.staticAccountKeys.map((key) => key.toString());
  }
  return tx.compileMessage().accountKeys.map((key) => key.toString());
}

function getTransactionInstructions(tx) {
  if (!(tx instanceof VersionedTransaction)) return tx.instructions;

  const keys = tx.message.staticAccountKeys;
  return tx.message.compiledInstructions
    .map((ix) => {
      const programId = keys[ix.programIdIndex];
      if (!programId) return null;
      const indexes = ix.accountKeyIndexes || ix.accounts || [];
      const accounts = indexes
        .map((accountIndex) => keys[accountIndex])
        .filter(Boolean);
      return new TransactionInstruction({
        programId,
        keys: accounts.map((pubkey) => ({ pubkey, isSigner: false, isWritable: false })),
        data: Buffer.from(ix.data),
      });
    })
    .filter(Boolean);
}

function assertNoUnsafeSystemTransfer(tx, wallet, allowedDestinations = []) {
  const owner = wallet.publicKey.toString();
  const allowed = new Set(allowedDestinations.filter(Boolean).map(String));

  for (const ix of getTransactionInstructions(tx)) {
    if (!ix.programId.equals(SystemProgram.programId)) continue;

    let type = null;
    try {
      type = SystemInstruction.decodeInstructionType(ix);
    } catch {
      continue;
    }
    if (type !== "Transfer" && type !== "TransferWithSeed") continue;

    const decoded = type === "Transfer"
      ? SystemInstruction.decodeTransfer(ix)
      : SystemInstruction.decodeTransferWithSeed(ix);
    const source = decoded.fromPubkey?.toString();
    const destination = decoded.toPubkey?.toString();
    if (source === owner && !allowed.has(destination)) {
      throw new Error(
        `Relay transaction contains direct SOL transfer from owner to ${destination?.slice(0, 8) || "unknown"}.`,
      );
    }
  }
}

function signSerializedTransactions(serializedTxs, wallet) {
  return (serializedTxs || [])
    .filter((entry) => typeof entry === "string" && entry.length > 0)
    .map((entry) => signSerializedTransaction(entry, wallet));
}

async function signAndSimulateRelayTransactions(serializedTxs, wallet, {
  label,
  allowedDebitMints = [],
  allowedSystemTransferDestinations = [],
  maxSolLoss = 0.05,
  requiredStaticAccounts = [],
} = {}) {
  const signed = [];
  const owner = wallet.publicKey.toString();
  const allowedMints = new Set(allowedDebitMints.filter(Boolean).map(String));
  const maxLamportLoss = Math.floor(Number(maxSolLoss) * 1e9);

  for (const [index, serialized] of (serializedTxs || []).entries()) {
    if (typeof serialized !== "string" || serialized.length === 0) continue;

    const signedBase64 = signSerializedTransaction(serialized, wallet);
    const tx = deserializeSignedTransaction(signedBase64);
    assertNoUnsafeSystemTransfer(tx, wallet, allowedSystemTransferDestinations);
    const staticKeys = getStaticAccountKeyStrings(tx);
    for (const account of requiredStaticAccounts.filter(Boolean)) {
      if (!staticKeys.includes(String(account))) {
        throw new Error(`Relay ${label || "transaction"} ${index + 1} missing required account ${String(account).slice(0, 8)}.`);
      }
    }

    const ownerIndex = staticKeys.indexOf(owner);
    const simulation = await getConnection().simulateTransaction(tx, {
      sigVerify: false,
      replaceRecentBlockhash: false,
    });
    const value = simulation.value;
    if (value.err) {
      throw new Error(`Relay ${label || "transaction"} ${index + 1} simulation failed: ${JSON.stringify(value.err)}`);
    }

    if (ownerIndex >= 0 && value.preBalances?.[ownerIndex] != null && value.postBalances?.[ownerIndex] != null) {
      const lamportDelta = value.postBalances[ownerIndex] - value.preBalances[ownerIndex];
      if (lamportDelta < -maxLamportLoss) {
        throw new Error(
          `Relay ${label || "transaction"} ${index + 1} would debit ${(Math.abs(lamportDelta) / 1e9).toFixed(6)} SOL from owner.`,
        );
      }
    }

    const preByMint = new Map();
    for (const balance of value.preTokenBalances || []) {
      if (balance.owner !== owner) continue;
      preByMint.set(balance.mint, BigInt(balance.uiTokenAmount?.amount || "0"));
    }
    for (const balance of value.postTokenBalances || []) {
      if (balance.owner !== owner) continue;
      const preAmount = preByMint.get(balance.mint) ?? 0n;
      const postAmount = BigInt(balance.uiTokenAmount?.amount || "0");
      if (postAmount < preAmount && !allowedMints.has(balance.mint)) {
        throw new Error(
          `Relay ${label || "transaction"} ${index + 1} would debit unrelated token mint ${balance.mint}.`,
        );
      }
      preByMint.delete(balance.mint);
    }
    for (const [mint, preAmount] of preByMint) {
      if (preAmount > 0n && !allowedMints.has(mint)) {
        throw new Error(`Relay ${label || "transaction"} ${index + 1} would close/debit unrelated token mint ${mint}.`);
      }
    }

    signed.push(signedBase64);
  }

  return signed;
}

function normalizeExecutionSignatures(result) {
  const signatures = [];
  const seen = new Set();
  for (const value of []
    .concat(result?.signatures || [])
    .concat(result?.result?.txHashes || [])
    .concat(result?.result?.signatures || [])
    .concat(result?.result?.signature ? [result.result.signature] : [])) {
    if (typeof value !== "string" || !value) continue;
    if (seen.has(value)) continue;
    seen.add(value);
    signatures.push(value);
  }
  return signatures;
}

const METEORA_INIT_BIN_ARRAY_DISCRIMINATOR = Buffer.from([35, 86, 19, 185, 78, 212, 75, 211]).toString("hex");
const METEORA_INIT_BITMAP_EXTENSION_DISCRIMINATOR = Buffer.from([47, 157, 226, 180, 12, 240, 33, 71]).toString("hex");

function getDlmmProgramId() {
  return new PublicKey("LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo");
}

function formatSolFee(value) {
  const number = Number(value ?? 0);
  return Number.isFinite(number) ? number.toFixed(8).replace(/0+$/, "").replace(/\.$/, "") : "unknown";
}

async function assertRangeDoesNotRequireBinArrayInitialization(pool, minBinId, maxBinId) {
  const {
    getBinArrayKeysCoverage,
    getBinArrayIndexesCoverage,
    deriveBinArrayBitmapExtension,
    isOverflowDefaultBinArrayBitmap,
    BIN_ARRAY_FEE,
    BIN_ARRAY_BITMAP_FEE,
  } = await getDLMM();

  if (!getBinArrayKeysCoverage || !getBinArrayIndexesCoverage) {
    throw new Error("Cannot verify Meteora bin-array initialization risk; refusing deploy.");
  }

  const programId = getDlmmProgramId();
  const poolPubkey = new PublicKey(pool.pubkey?.toString?.() || pool.lbPair?.publicKey?.toString?.() || pool.lbPair?.pubkey?.toString?.());
  const lower = new BN(Math.min(minBinId, maxBinId));
  const upper = new BN(Math.max(minBinId, maxBinId));
  const indexes = getBinArrayIndexesCoverage(lower, upper);
  const keys = getBinArrayKeysCoverage(lower, upper, poolPubkey, programId);
  const accounts = await getConnection().getMultipleAccountsInfo(keys, "confirmed");
  const missing = accounts
    .map((account, index) => account ? null : {
      index: indexes[index]?.toString?.() ?? String(index),
      address: keys[index].toString(),
    })
    .filter(Boolean);

  if (missing.length > 0) {
    const totalFee = missing.length * Number(BIN_ARRAY_FEE ?? 0.07143744);
    const sample = missing.slice(0, 3).map((entry) => `${entry.index}:${entry.address.slice(0, 8)}`).join(", ");
    throw new Error(
      `Deploy skipped: selected range requires ${missing.length} missing Meteora bin-array initialization(s) ` +
      `(~${formatSolFee(totalFee)} SOL non-refundable pool rent; ${formatSolFee(BIN_ARRAY_FEE ?? 0.07143744)} SOL each). ` +
      `Missing indexes: ${sample}${missing.length > 3 ? ", ..." : ""}. Pick an already-initialized range/pool.`,
    );
  }

  if (deriveBinArrayBitmapExtension && isOverflowDefaultBinArrayBitmap) {
    const needsBitmapExtension = indexes.some((index) => isOverflowDefaultBinArrayBitmap(index));
    if (needsBitmapExtension) {
      const [bitmapExtension] = deriveBinArrayBitmapExtension(poolPubkey, programId);
      const account = await getConnection().getAccountInfo(bitmapExtension, "confirmed");
      if (!account) {
        throw new Error(
          `Deploy skipped: selected range requires Meteora bin-array bitmap extension initialization ` +
          `(~${formatSolFee(BIN_ARRAY_BITMAP_FEE ?? 0.01180416)} SOL non-refundable pool rent). Pick a closer initialized range/pool.`,
        );
      }
    }
  }
}

function assertNoInitializeBinArrayInstructions(serializedTxs) {
  const offenders = [];
  for (const serialized of serializedTxs || []) {
    if (typeof serialized !== "string" || serialized.length === 0) continue;
    for (const discriminator of getDlmmInstructionDiscriminators(serialized)) {
      if (discriminator === METEORA_INIT_BIN_ARRAY_DISCRIMINATOR) {
        offenders.push("initializeBinArray");
      } else if (discriminator === METEORA_INIT_BITMAP_EXTENSION_DISCRIMINATOR) {
        offenders.push("initializeBinArrayBitmapExtension");
      }
    }
  }
  if (offenders.length > 0) {
    throw new Error(
      `Deploy skipped: generated transaction includes Meteora ${[...new Set(offenders)].join(" / ")} ` +
      "instruction(s), which would charge non-refundable pool initialization rent.",
    );
  }
}

function getDlmmInstructionDiscriminators(serialized) {
  const bytes = Buffer.from(serialized, "base64");
  const dlmmProgramId = getDlmmProgramId().toString();
  try {
    const versioned = VersionedTransaction.deserialize(bytes);
    return versioned.message.compiledInstructions
      .map((ix) => {
        const programId = versioned.message.staticAccountKeys[ix.programIdIndex]?.toString();
        if (programId !== dlmmProgramId) return null;
        return Buffer.from(ix.data || []).subarray(0, 8).toString("hex");
      })
      .filter(Boolean);
  } catch {
    const legacy = Transaction.from(bytes);
    return legacy.instructions
      .map((ix) => ix.programId.toString() === dlmmProgramId ? Buffer.from(ix.data || []).subarray(0, 8).toString("hex") : null)
      .filter(Boolean);
  }
}

// ─── Pool Cache ────────────────────────────────────────────────
const poolCache = new Map();
const poolMetadataCache = new Map();

async function getPool(poolAddress) {
  const key = poolAddress.toString();
  if (!poolCache.has(key)) {
    const { DLMM } = await getDLMM();
    const pool = await DLMM.create(getConnection(), new PublicKey(poolAddress));
    poolCache.set(key, pool);
  }
  return poolCache.get(key);
}

// P1: Reduce poolCache TTL to 60s — 5 minutes was too long for close/claim/activeBin lookups.
// Deploy already force-clears the cache per-pool before use, but close and activeBin queries
// were still reading SDK objects up to 5 minutes stale.
// poolMetadataCache (name/symbols only) is less time-sensitive; keep at 15 minutes.
setInterval(() => poolCache.clear(), 60 * 1000);
setInterval(() => poolMetadataCache.clear(), 15 * 60 * 1000);

async function getPoolMetadata(poolAddress) {
  const key = String(poolAddress);
  if (poolMetadataCache.has(key)) {
    return poolMetadataCache.get(key);
  }

  try {
    const data = await fetchJsonWithRetry(`https://dlmm.datapi.meteora.ag/pools/${key}`, {
      label: `pool metadata ${key.slice(0, 8)}`,
      attempts: 3,
      timeoutMs: 5_000,
    });
    const tokenX = data?.token_x?.symbol || null;
    const tokenY = data?.token_y?.symbol || null;
    const pair = data?.name || (tokenX && tokenY ? `${tokenX}-${tokenY}` : null);
    const meta = {
      address: data?.address || key,
      name: pair,
      token_x_symbol: tokenX,
      token_y_symbol: tokenY,
      metadata_quality: "complete",
    };
    poolMetadataCache.set(key, meta);
    return meta;
  } catch (error) {
    log("pool_meta_warn", `Pool metadata lookup failed for ${key.slice(0, 8)}: ${error.message}`);
    // P3: metadata_quality flag — callers can detect silent API failure rather than
    // assuming null name/symbols mean the pool has no metadata.
    const fallback = { address: key, name: null, token_x_symbol: null, token_y_symbol: null, metadata_quality: "fallback" };
    poolMetadataCache.set(key, fallback);
    return fallback;
  }
}

// ─── Get Active Bin ────────────────────────────────────────────
export async function getActiveBin({ pool_address }) {
  pool_address = normalizeMint(pool_address);
  const pool = await getPool(pool_address);
  const activeBin = await pool.getActiveBin();

  return {
    binId: activeBin.binId,
    price: pool.fromPricePerLamport(Number(activeBin.price)),
    pricePerLamport: activeBin.price.toString(),
  };
}

// ─── Deploy Position ───────────────────────────────────────────
export async function deployPosition({
  pool_address,
  amount_sol, // legacy: will be used as amount_y if amount_y is not provided
  amount_x,
  amount_y,
  strategy,
  bins_below,
  bins_above,
  downside_pct,
  upside_pct,
  // optional pool metadata for learning (passed by agent when available)
  pool_name,
  bin_step,
  base_fee,
  volatility,
  fee_tvl_ratio,
  organic_score,
  initial_value_usd,
}) {
  pool_address = normalizeMint(pool_address);
  const activeStrategy = strategy || config.strategy.strategy;
  let activeBinsBelow = bins_below ?? config.strategy.defaultBinsBelow ?? config.strategy.minBinsBelow;
  let activeBinsAbove = bins_above ?? 0;
  const parsedVolatility = volatility == null ? null : Number(volatility);
  const normalizedVolatility = parsedVolatility != null && Number.isFinite(parsedVolatility) ? parsedVolatility : null;

  if (volatility != null && (normalizedVolatility == null || normalizedVolatility <= 0)) {
    throw new Error(`Invalid volatility ${volatility} — refusing deploy because the volatility feed is unusable.`);
  }

  if (isPoolOnCooldown(pool_address)) {
    log("deploy", `Pool ${pool_address.slice(0, 8)} is on cooldown — skipping`);
    return { success: false, error: "Pool on cooldown — was recently closed with a cooldown reason. Try a different pool." };
  }

  const { StrategyType, getBinIdFromPrice, getPriceOfBinByBinId } = await getDLMM();
  // P2: Always fetch fresh pool object for deploy — stale SDK state could hold
  // outdated active-bin or price data from up to 5 minutes ago.
  poolCache.delete(pool_address);
  const pool = await getPool(pool_address);
  const baseMint = pool.lbPair.tokenXMint.toString();
  if (isBaseMintOnCooldown(baseMint)) {
    log("deploy", `Base mint ${baseMint.slice(0, 8)} is on cooldown — skipping deploy for pool ${pool_address.slice(0, 8)}`);
    return { success: false, error: "Token on cooldown — recently closed out-of-range too many times. Try a different token." };
  }
  const activeBin = await pool.getActiveBin();
  const actualBinStep = pool.lbPair.binStep;
  const activePrice = Number(getPriceOfBinByBinId(activeBin.binId, actualBinStep).toString());

  if (downside_pct != null || upside_pct != null) {
    const downsidePct = Math.max(0, Number(downside_pct ?? 0));
    const upsidePct = Math.max(0, Number(upside_pct ?? 0));

    if (!Number.isFinite(downsidePct) || !Number.isFinite(upsidePct)) {
      throw new Error("downside_pct and upside_pct must be valid numbers.");
    }
    if (downsidePct >= 100) {
      throw new Error("downside_pct must be less than 100.");
    }

    const lowerTargetPrice = activePrice * (1 - downsidePct / 100);
    const upperTargetPrice = activePrice * (1 + upsidePct / 100);
    const lowerBinId = getBinIdFromPrice(lowerTargetPrice, actualBinStep, true);
    const upperBinId = getBinIdFromPrice(upperTargetPrice, actualBinStep, false);

    activeBinsBelow = Math.max(0, activeBin.binId - lowerBinId);
    activeBinsAbove = Math.max(0, upperBinId - activeBin.binId);
  }

  const strategyMap = {
    spot: StrategyType.Spot,
    curve: StrategyType.Curve,
    bid_ask: StrategyType.BidAsk,
  };

  const strategyType = strategyMap[activeStrategy];
  if (strategyType === undefined) {
    throw new Error(`Invalid strategy: ${activeStrategy}. Use spot, curve, or bid_ask.`);
  }

  // Calculate amounts
  // If no explicit SOL amount is provided, fall back to the configured dynamic deploy size.
  const fallbackAmountY =
    amount_y == null && amount_sol == null
      ? computeDeployAmount((await getWalletBalances()).sol)
      : 0;
  const finalAmountY = Number(amount_y ?? amount_sol ?? fallbackAmountY);
  const finalAmountX = Number(amount_x ?? 0);
  if (!Number.isFinite(finalAmountY) || !Number.isFinite(finalAmountX) || finalAmountY < 0 || finalAmountX < 0) {
    throw new Error("Invalid deploy amount: amount_x and amount_y must be valid non-negative numbers.");
  }
  if (finalAmountX > 0) {
    throw new Error("Unsupported deploy amount: this agent only supports single-side SOL deploys. Use amount_y/amount_sol and keep amount_x=0.");
  }
  if (finalAmountY <= 0) {
    throw new Error("Invalid deploy amount: provide a positive amount_y/amount_sol.");
  }
  const isSingleSidedSol = finalAmountX <= 0 && finalAmountY > 0;

  // P0: Verify tokenY is SOL/wSOL before single-side SOL deploy.
  // Hard-coding 1e9 is only safe when tokenY is confirmed to be SOL (decimals=9).
  // Reject early if pool tokenY is something else (e.g. USDC=6 decimals would cause
  // a 1000× nominal error).
  if (isSingleSidedSol) {
    const SOL_MINT = "So11111111111111111111111111111111111111112";
    const tokenYMint = pool.lbPair.tokenYMint.toString();
    if (tokenYMint !== SOL_MINT) {
      throw new Error(
        `Single-side SOL deploy requires tokenY to be SOL/wSOL. ` +
        `Got tokenY=${tokenYMint}. Refusing deploy to avoid decimal mismatch.`
      );
    }
  }

  if (isSingleSidedSol && (Number(bins_above ?? 0) > 0 || Number(upside_pct ?? 0) > 0)) {
    throw new Error(
      "Single-side SOL deploy cannot use bins_above or upside_pct. Use amount_y with bins_below only; the upper bin is the SDK active bin.",
    );
  }
  if (isSingleSidedSol) {
    activeBinsAbove = 0;
  }
  activeBinsBelow = Number(activeBinsBelow);
  activeBinsAbove = Number(activeBinsAbove);
  if (!Number.isFinite(activeBinsBelow) || !Number.isFinite(activeBinsAbove)) {
    throw new Error("Invalid bin range: bins_below and bins_above must be valid numbers.");
  }
  if (activeBinsBelow < 0 || activeBinsAbove < 0) {
    throw new Error("Invalid bin range: bins_below and bins_above cannot be negative.");
  }
  if (!Number.isInteger(activeBinsBelow) || !Number.isInteger(activeBinsAbove)) {
    throw new Error("Invalid bin range: bins_below and bins_above must be whole-bin integers.");
  }
  const minBinsBelow = Math.max(MIN_SAFE_BINS_BELOW, Number(config.strategy.minBinsBelow ?? MIN_SAFE_BINS_BELOW));
  const totalBins = activeBinsBelow + activeBinsAbove;
  if (totalBins < minBinsBelow) {
    throw new Error(
      `Invalid deploy range: total bins ${totalBins} is below minimum ${minBinsBelow}. Refusing 1-bin/tiny-range deploy.`,
    );
  }

  const isWideRange = totalBins > 69;
  const minBinId = activeBin.binId - activeBinsBelow;
  const maxBinId = isSingleSidedSol ? activeBin.binId : activeBin.binId + activeBinsAbove;

  if (minBinId > maxBinId) {
    throw new Error(`Invalid bin range: ${minBinId} -> ${maxBinId}`);
  }
  if (isSingleSidedSol && maxBinId !== activeBin.binId) {
    throw new Error(
      `Single-side SOL deploy must end at the SDK active bin. Expected ${activeBin.binId}, got ${maxBinId}.`,
    );
  }

  const minPrice = Number(getPriceOfBinByBinId(minBinId, actualBinStep).toString());
  const maxPrice = Number(getPriceOfBinByBinId(maxBinId, actualBinStep).toString());
  const downsideCoveragePct = activePrice > 0 ? ((activePrice - minPrice) / activePrice) * 100 : null;
  const upsideCoveragePct = activePrice > 0 ? ((maxPrice - activePrice) / activePrice) * 100 : null;
  const totalWidthPct = minPrice > 0 ? ((maxPrice - minPrice) / minPrice) * 100 : null;
  const baseFactor = pool.lbPair.parameters?.baseFactor ?? 0;
  const actualBaseFee = base_fee ?? (baseFactor > 0 ? parseFloat((baseFactor * actualBinStep / 1e6 * 100).toFixed(4)) : null);
  if (process.env.DRY_RUN === "true") {
    return {
      dry_run: true,
      pool: pool_address,
      pool_name,
      strategy: activeStrategy,
      amount_x: finalAmountX,
      amount_y: finalAmountY,
      active_bin: activeBin.binId,
      bin_range: {
        min: minBinId,
        max: maxBinId,
        active: activeBin.binId,
      },
      price_range: { min: minPrice, max: maxPrice },
      range_coverage: {
        downside_pct: downsideCoveragePct,
        upside_pct: upsideCoveragePct,
        width_pct: totalWidthPct,
        active_price: activePrice,
      },
      bin_step: actualBinStep,
      base_fee: actualBaseFee,
      simulated_ledger: {
        event: "deploy",
        wallet_delta_sol: -finalAmountY,
        locked_in_pool_sol: finalAmountY,
        note: "Dry-run simulation only; no on-chain balance changed.",
      },
      would_deploy: {
        pool_address,
        pool_name,
        strategy: activeStrategy,
        bins_below: activeBinsBelow,
        bins_above: activeBinsAbove,
        active_bin: activeBin.binId,
        downside_pct: downside_pct ?? null,
        upside_pct: upside_pct ?? null,
        amount_x: finalAmountX,
        amount_y: finalAmountY,
        wide_range: isWideRange,
      },
      message: "DRY RUN — no transaction sent",
    };
  }

  assertDeployCircuitClosed(pool_address);

  // P1: Deploy pending lock — prevents duplicate deploy to same pool in concurrent calls.
  // Phase 1: Acquire atomic O_CREAT|O_EXCL fs lock to eliminate TOCTOU race between processes.
  // Phase 2: With fs lock held, reload from disk + check Map (serialized check-and-set).
  // Phase 3: Release fs lock — Map+persistence guard the rest of the deploy duration.
  const _deployFsLock = _acquireFsLock(`deploy:${pool_address}`);
  if (!_deployFsLock.acquired) {
    return {
      success: false,
      error: "Deploy already in progress for this pool — lock held by another process.",
    };
  }
  _reloadPendingFromDisk();
  if (_deployPending.has(pool_address)) {
    _releaseFsLock(_deployFsLock);
    return {
      success: false,
      error: "Deploy already in progress for this pool — wait for current deploy to complete.",
    };
  }
  _deployPending.set(pool_address, Date.now());
  _savePendingState();
  _releaseFsLock(_deployFsLock);
  try {

  // P1: Deploy slippage configurable and capped at 500 bps (5%).
  // Default 300 bps (3%) — enough for single-side SOL into an existing pool.
  // 1000 bps (10%) was too loose; validate before clamp to catch NaN configs.
  const _rawDeploySlippage = Number(config.management?.deploySlippageBps ?? 300);
  if (!Number.isFinite(_rawDeploySlippage)) {
    throw new Error("Invalid deploySlippageBps — must be a finite number.");
  }
  const deploySlippageBps = Math.min(Math.max(1, _rawDeploySlippage), 500);

  await assertRangeDoesNotRequireBinArrayInitialization(pool, minBinId, maxBinId);

  // Read base fee directly from pool — baseFactor * binStep / 10^6 gives fee in %
  const totalYLamports = new BN(Math.floor(finalAmountY * 1e9));
  // Token X amount uses mint decimals when available, falling back to 9.
  let totalXLamports = new BN(0);
  if (finalAmountX > 0) {
    const mintInfo = await getConnection().getParsedAccountInfo(new PublicKey(pool.lbPair.tokenXMint));
    const decimals = mintInfo.value?.data?.parsed?.info?.decimals ?? 9;
    totalXLamports = new BN(Math.floor(finalAmountX * Math.pow(10, decimals)));
  }

  if (shouldUseLpAgentRelayForDeploy()) {
    try {
      const wallet = getWallet();
      log(
        "deploy",
        `Relay deploy via Agent Meridian: ${pool_address} activeBin ${activeBin.binId} bins ${minBinId}->${maxBinId} amountY=${finalAmountY}`,
      );
      const order = await agentMeridianJson("/execution/zap-in/order", {
        method: "POST",
        headers: getAgentMeridianHeaders({ json: true }),
        body: JSON.stringify({
          agentId: getAgentIdForRequests(),
          idempotencyKey: `deploy:${pool_address}:${minBinId}:${maxBinId}:${finalAmountY}:${finalAmountX}`,
          poolId: pool_address,
          owner: wallet.publicKey.toString(),
          strategy: activeStrategy === "spot" ? "Spot" : "BidAsk",
          inputSOL: finalAmountY,
          amountY: finalAmountY,
          amountX: finalAmountX,
          percentX: finalAmountX > 0 && finalAmountY > 0 ? 0.5 : 0,
          fromBinId: minBinId,
          toBinId: maxBinId,
          slippageBps: 500,
          provider: "JUPITER_ULTRA",
        }),
      });

      const addLiquidityUnsigned = order?.order?.transactions?.addLiquidity || [];
      const swapUnsigned = order?.order?.transactions?.swap || [];
      if (addLiquidityUnsigned.length + swapUnsigned.length === 0) {
        throw new Error("LPAgent order returned no transactions. Check the pool address, deploy amount, and selected range.");
      }
      assertNoInitializeBinArrayInstructions(addLiquidityUnsigned);

      const addLiquidity = signSerializedTransactions(addLiquidityUnsigned, wallet);
      const swap = signSerializedTransactions(swapUnsigned, wallet);
      const submit = await agentMeridianJson("/execution/zap-in/submit", {
        method: "POST",
        headers: getAgentMeridianHeaders({ json: true }),
        body: JSON.stringify({
          requestId: order.requestId,
          lastValidBlockHeight: order?.order?.lastValidBlockHeight,
          transactions: {
            addLiquidity,
            swap,
          },
          meta: {
            pool: pool_address,
            strategy: activeStrategy,
          },
        }),
      });

      await new Promise((resolve) => setTimeout(resolve, 5000));
      _positionsCacheAt = 0;
      const refreshed = await getMyPositions({ force: true, silent: true }).catch(() => null);
      const matching = refreshed?.positions?.find(
        (position) => position.pool === pool_address && position.lower_bin === minBinId && position.upper_bin === maxBinId,
      ) || refreshed?.positions?.find((position) => position.pool === pool_address);

      const positionAddress = matching?.position || null;
      if (positionAddress) {
        trackPosition({
          position: positionAddress,
          pool: pool_address,
          pool_name,
          strategy: activeStrategy,
          bin_range: { min: minBinId, max: maxBinId, bins_below: activeBinsBelow, bins_above: activeBinsAbove },
          bin_step,
          volatility: normalizedVolatility,
          fee_tvl_ratio,
          organic_score,
          amount_sol: finalAmountY,
          amount_x: finalAmountX,
          active_bin: activeBin.binId,
          initial_value_usd,
        });
      }

      appendDecision({
        type: "deploy",
        actor: "SCREENER",
        pool: pool_address,
        pool_name,
        position: positionAddress,
        summary: `Relay deployed ${finalAmountY} SOL with ${activeStrategy}`,
        reason: `Chosen range ${minBinId}→${maxBinId} around active bin ${activeBin.binId}`,
        risks: [
          normalizedVolatility != null ? `volatility ${normalizedVolatility}` : null,
          fee_tvl_ratio != null ? `fee/TVL ${fee_tvl_ratio}%` : null,
        ].filter(Boolean),
        metrics: {
          amount_sol: finalAmountY,
          strategy: activeStrategy,
          active_bin: activeBin.binId,
          min_bin: minBinId,
          max_bin: maxBinId,
          downside_pct: downside_pct ?? downsideCoveragePct,
          upside_pct: upside_pct ?? upsideCoveragePct,
        },
      });

      const _relayTxs = normalizeExecutionSignatures(submit);
      return {
        success: true,
        relay: true,
        request_id: order.requestId,
        position: positionAddress,
        pool: pool_address,
        pool_name,
        bin_range: { min: minBinId, max: maxBinId, active: activeBin.binId },
        price_range: { min: minPrice, max: maxPrice },
        range_coverage: {
          downside_pct: downsideCoveragePct,
          upside_pct: upsideCoveragePct,
          width_pct: totalWidthPct,
          active_price: activePrice,
        },
        bin_step: actualBinStep,
        base_fee: actualBaseFee,
        strategy: activeStrategy,
        wide_range: isWideRange,
        amount_x: finalAmountX,
        amount_y: finalAmountY,
        txs: _relayTxs,
        ...syntheticFlag(_relayTxs),
      };
    } catch (error) {
      log("deploy_error", `Relay deploy failed: ${error.message}`);
      return { success: false, error: error.message };
    }
  }

  const wallet = getWallet();
  const newPosition = Keypair.generate();

  log("deploy", `Pool: ${pool_address}`);
  log("deploy", `Strategy: ${activeStrategy}, Bins: ${minBinId} to ${maxBinId} (${totalBins} bins${isWideRange ? " — WIDE RANGE" : ""})`);
  log("deploy", `Amount: ${finalAmountX} X, ${finalAmountY} Y`);
  log("deploy", `Position: ${newPosition.publicKey.toString()}`);

  try {
    const txHashes = [];

    if (isWideRange) {
      // ── Wide Range Path (>69 bins) ─────────────────────────────────
      // Solana limits inner instruction realloc to 10240 bytes, so we can't create
      // a large position in a single initializePosition ix.
      // Solution: createExtendedEmptyPosition (returns Transaction | Transaction[]),
      //           then addLiquidityByStrategyChunkable (returns Transaction[]).

      // Phase 1: Create empty position (may be multiple txs)
      const createTxs = await pool.createExtendedEmptyPosition(
        minBinId,
        maxBinId,
        newPosition.publicKey,
        wallet.publicKey,
      );
      const createTxArray = Array.isArray(createTxs) ? createTxs : [createTxs];
      for (let i = 0; i < createTxArray.length; i++) {
        const signers = i === 0 ? [wallet, newPosition] : [wallet];
        const txHash = await sendAndConfirmWithReconciliation(createTxArray[i], signers, {
          label: `deploy:create:${pool_address.slice(0, 8)}:${i + 1}`,
          verify: () => verifyAccountExists(newPosition.publicKey),
        });
        txHashes.push(txHash);
        log("deploy", `Create tx ${i + 1}/${createTxArray.length}: ${txHash}`);
      }

      // Phase 2: Add liquidity (may be multiple txs)
      const addTxs = await pool.addLiquidityByStrategyChunkable({
        positionPubKey: newPosition.publicKey,
        user: wallet.publicKey,
        totalXAmount: totalXLamports,
        totalYAmount: totalYLamports,
        strategy: { minBinId, maxBinId, strategyType },
        slippage: deploySlippageBps,
      });
      const addTxArray = Array.isArray(addTxs) ? addTxs : [addTxs];
      for (let i = 0; i < addTxArray.length; i++) {
        const txHash = await sendAndConfirmWithReconciliation(addTxArray[i], [wallet], {
          label: `deploy:add-liquidity:${pool_address.slice(0, 8)}:${i + 1}`,
          verify: () => verifyPositionHasLiquidity(newPosition.publicKey.toString(), pool_address),
        });
        txHashes.push(txHash);
        log("deploy", `Add liquidity tx ${i + 1}/${addTxArray.length}: ${txHash}`);
      }
    } else {
      // ── Standard Path (≤69 bins) ─────────────────────────────────
      const tx = await pool.initializePositionAndAddLiquidityByStrategy({
        positionPubKey: newPosition.publicKey,
        user: wallet.publicKey,
        totalXAmount: totalXLamports,
        totalYAmount: totalYLamports,
        strategy: { maxBinId, minBinId, strategyType },
        slippage: deploySlippageBps,
      });
      const txHash = await sendAndConfirmWithReconciliation(tx, [wallet, newPosition], {
        label: `deploy:init-add:${pool_address.slice(0, 8)}`,
        verify: async () => (
          await verifyAccountExists(newPosition.publicKey)
          && await verifyPositionOpen(newPosition.publicKey.toString(), { poolAddress: pool_address, minBinId, maxBinId })
          && await verifyPositionHasLiquidity(newPosition.publicKey.toString(), pool_address)
        ),
      });
      txHashes.push(txHash);
    }

    log("deploy", `SUCCESS — ${txHashes.length} tx(s): ${txHashes[0]}`);

    _positionsCacheAt = 0;
    trackPosition({
      position: newPosition.publicKey.toString(),
      pool: pool_address,
      pool_name,
      strategy: activeStrategy,
      bin_range: { min: minBinId, max: maxBinId, bins_below: activeBinsBelow, bins_above: activeBinsAbove },
      bin_step,
      volatility: normalizedVolatility,
      fee_tvl_ratio,
      organic_score,
      amount_sol: finalAmountY,
      amount_x: finalAmountX,
      active_bin: activeBin.binId,
      initial_value_usd,
    });

    appendDecision({
      type: "deploy",
      actor: "SCREENER",
      pool: pool_address,
      pool_name,
      position: newPosition.publicKey.toString(),
      summary: `Deployed ${finalAmountY} SOL with ${activeStrategy}`,
      reason: `Chosen range ${minBinId}→${maxBinId} around active bin ${activeBin.binId}`,
      risks: [
        normalizedVolatility != null ? `volatility ${normalizedVolatility}` : null,
        fee_tvl_ratio != null ? `fee/TVL ${fee_tvl_ratio}%` : null,
      ].filter(Boolean),
      metrics: {
        amount_sol: finalAmountY,
        strategy: activeStrategy,
        active_bin: activeBin.binId,
        min_bin: minBinId,
        max_bin: maxBinId,
        downside_pct: downside_pct ?? null,
        upside_pct: upside_pct ?? null,
      },
    });

    return {
      success: true,
      position: newPosition.publicKey.toString(),
      pool: pool_address,
      pool_name,
      bin_range: { min: minBinId, max: maxBinId, active: activeBin.binId },
      price_range: { min: minPrice, max: maxPrice },
      range_coverage: {
        downside_pct: downsideCoveragePct,
        upside_pct: upsideCoveragePct,
        width_pct: totalWidthPct,
        active_price: activePrice,
      },
      bin_step: actualBinStep,
      base_fee: actualBaseFee,
      strategy: activeStrategy,
      wide_range: isWideRange,
      amount_x: finalAmountX,
      amount_y: finalAmountY,
      txs: txHashes,
      ...syntheticFlag(txHashes),
    };
  } catch (error) {
    log("deploy_error", error.message);
    return { success: false, error: error.message };
  }

  } finally {
    _deployPending.delete(pool_address);
    _savePendingState();
  }
}

// P1: 1-minute cache — 5 minutes was too stale for volatile DLMM pools.
// Active bin can shift significantly in 5 min; manager could think it's in-range when OOR.
const POSITIONS_CACHE_TTL = 60_000; // 1 minute
// P1: Near-edge positions get a shorter TTL — active bin within 2 bins of range boundary
// means an OOR event could happen within seconds; stale data would miss it.
const POSITIONS_NEAR_EDGE_CACHE_TTL = 15_000; // 15 seconds

let _positionsCache = null;
let _positionsCacheAt = 0;
let _positionsInflight = null; // deduplicates concurrent calls

// P1: Pending operation guards — prevent race-condition double-deploy/double-close.
// Stored as Map<address, timestamp> and persisted to pending_operations.json so the guard
// survives PM2 restart, VPS reboot, or Node crash. Entries auto-expire after 30 minutes
// (covers the longest realistic transaction confirmation window on Solana).
// P1: Anchor pending state to process.cwd() (project root) rather than relative to this file.
// If dlmm.js is ever moved to a subdirectory the path stays correct.
// Override via DLMM_PENDING_STATE_FILE env var for non-standard setups.
const PENDING_STATE_FILE =
  process.env.DLMM_PENDING_STATE_FILE ||
  path.resolve(process.cwd(), "pending_operations.json");
const PENDING_TTL_MS = 30 * 60 * 1000; // 30 minutes

const _deployPending = new Map(); // pool_address → started_at timestamp
const _closePending  = new Map(); // position_address → started_at timestamp
const _claimPending  = new Map(); // position_address → started_at timestamp

function _pendingStateChecksum(state) {
  return crypto
    .createHash("sha256")
    .update(JSON.stringify(state))
    .digest("hex");
}

function _isPlainObject(value) {
  return value != null && typeof value === "object" && !Array.isArray(value);
}

function _quarantinePendingState(reason) {
  const quarantinePath = `${PENDING_STATE_FILE}.corrupt.${Date.now()}`;
  try {
    fs.renameSync(PENDING_STATE_FILE, quarantinePath);
    log("pending_state_warn", `Quarantined pending state (${reason}) to ${path.basename(quarantinePath)}`);
  } catch (error) {
    log("pending_state_warn", `Failed to quarantine pending state after ${reason}: ${error.message}`);
  }
}

// Check whether a PID is still alive using signal 0 (no actual signal sent).
// Returns true when pid is unknown/unverifiable — never blocks on doubt.
function _isPidAlive(pid) {
  if (!pid || typeof pid !== "number") return true;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e.code !== "ESRCH"; // ESRCH = no such process; other errors = process exists
  }
}

// ─── OS-level atomic file lock (O_CREAT|O_EXCL) ──────────────────
// Uses a per-key .oplock file alongside pending_operations.json.
// fs.writeFileSync with flag:'wx' maps to open(O_CREAT|O_EXCL|O_WRONLY) which is a
// single atomic syscall on Linux ext4/NTFS — only one process wins the race.
// Returns { acquired: true, file: path } on success, { acquired: false } on contention.
function _acquireFsLock(key) {
  const lockFile = `${PENDING_STATE_FILE}.${key.slice(0, 12).replace(/[^a-zA-Z0-9]/g, "_")}.oplock`;
  const content  = JSON.stringify({ pid: process.pid, key, ts: Date.now() });
  try {
    fs.writeFileSync(lockFile, content, { flag: "wx" }); // atomic O_CREAT|O_EXCL
    return { acquired: true, file: lockFile };
  } catch (e) {
    if (e.code !== "EEXIST") return { acquired: true }; // unexpected error — don't block
    // Lock file exists; check whether owner is still alive
    try {
      const existing = JSON.parse(fs.readFileSync(lockFile, "utf8"));
      if (!_isPidAlive(existing.pid)) {
        // Owner is dead — steal the stale lock (unlink is also atomic at dir level)
        fs.unlinkSync(lockFile);
        log("pending_state", `Stole stale oplock for ${key.slice(0, 8)} from dead PID ${existing.pid}`);
        return _acquireFsLock(key); // single retry after steal
      }
    } catch { /* can't read lock file — don't block */ return { acquired: true }; }
    return { acquired: false }; // live owner holds the lock
  }
}

function _releaseFsLock(lockResult) {
  if (lockResult?.file) try { fs.unlinkSync(lockResult.file); } catch { /* silent */ }
}

function _savePendingState() {
  try {
    // Embed pid alongside ts so other processes can detect stale locks from dead workers.
    const pid = process.pid;
    const toEntry = (ts) => ({ ts, pid });
    const state = {
      deploy:  Object.fromEntries([..._deployPending].map(([k, ts]) => [k, toEntry(ts)])),
      close:   Object.fromEntries([..._closePending].map(([k, ts])  => [k, toEntry(ts)])),
      claim:   Object.fromEntries([..._claimPending].map(([k, ts])  => [k, toEntry(ts)])),
      updated: Date.now(),
    };
    const envelope = {
      version: 1,
      checksum: _pendingStateChecksum(state),
      state,
    };
    // P1: Atomic write — write to .tmp then rename so a mid-write crash
    // (VPS reboot, OOM kill) cannot corrupt the live pending_operations.json.
    // rename() is atomic on NTFS and ext4.
    const tmp = PENDING_STATE_FILE + ".tmp";
    fs.writeFileSync(tmp, JSON.stringify(envelope, null, 2), "utf8");
    fs.renameSync(tmp, PENDING_STATE_FILE);
  } catch (e) {
    log("pending_state_warn", `Failed to save pending state: ${e.message}`);
  }
}

function _loadPendingState() {
  try {
    if (!fs.existsSync(PENDING_STATE_FILE)) return;
    const raw = JSON.parse(fs.readFileSync(PENDING_STATE_FILE, "utf8"));
    let state = raw;
    if (raw?.version === 1 || raw?.checksum || raw?.state) {
      if (!_isPlainObject(raw.state) || typeof raw.checksum !== "string") {
        _quarantinePendingState("invalid envelope");
        return;
      }
      const expected = _pendingStateChecksum(raw.state);
      if (expected !== raw.checksum) {
        _quarantinePendingState("checksum mismatch");
        return;
      }
      state = raw.state;
    } else {
      log("pending_state_warn", "Loaded legacy pending state without checksum; it will be rewritten with checksum on next save.");
    }

    if (!_isPlainObject(state.deploy) || !_isPlainObject(state.close) ||
        (state.claim != null && !_isPlainObject(state.claim))) {
      _quarantinePendingState("invalid schema");
      return;
    }

    const now = Date.now();
    let loaded = 0, skippedDead = 0;
    // Support both old format (plain number ts) and new format ({ts, pid}).
    const parseEntry = (entry) => {
      if (typeof entry === "number") return { ts: entry, pid: null };
      if (_isPlainObject(entry))     return { ts: Number(entry.ts ?? 0), pid: entry.pid ?? null };
      return { ts: 0, pid: null };
    };
    for (const [pool, raw] of Object.entries(state.deploy || {})) {
      const { ts, pid } = parseEntry(raw);
      if (now - ts >= PENDING_TTL_MS) continue;
      if (pid && !_isPidAlive(pid)) { skippedDead++; continue; }
      _deployPending.set(pool, ts); loaded++;
    }
    for (const [pos, raw] of Object.entries(state.close || {})) {
      const { ts, pid } = parseEntry(raw);
      if (now - ts >= PENDING_TTL_MS) continue;
      if (pid && !_isPidAlive(pid)) { skippedDead++; continue; }
      _closePending.set(pos, ts); loaded++;
    }
    for (const [pos, raw] of Object.entries(state.claim || {})) {
      const { ts, pid } = parseEntry(raw);
      if (now - ts >= PENDING_TTL_MS) continue;
      if (pid && !_isPidAlive(pid)) { skippedDead++; continue; }
      _claimPending.set(pos, ts); loaded++;
    }
    if (loaded > 0)      log("pending_state", `Loaded ${loaded} pending op(s) — will block re-deploy/re-close/re-claim for up to 30 min.`);
    if (skippedDead > 0) log("pending_state", `Released ${skippedDead} stale lock(s) from dead process(es).`);
  } catch (e) {
    log("pending_state_warn", `Failed to load pending state: ${e.message}`);
  }
}
log("pending_state", `Using pending state file: ${PENDING_STATE_FILE}`);
_loadPendingState();

// Re-read pending state from disk to pick up locks set by other processes (e.g. PM2 cluster).
// Clears and re-populates all Maps. Reduces (but cannot eliminate) multi-process TOCTOU window.
function _reloadPendingFromDisk() {
  try {
    if (!fs.existsSync(PENDING_STATE_FILE)) return;
    const raw = JSON.parse(fs.readFileSync(PENDING_STATE_FILE, "utf8"));
    let state = raw;
    if (raw?.version === 1 || raw?.checksum || raw?.state) {
      if (!_isPlainObject(raw.state) || typeof raw.checksum !== "string") return;
      if (_pendingStateChecksum(raw.state) !== raw.checksum) return;
      state = raw.state;
    }
    if (!_isPlainObject(state.deploy) || !_isPlainObject(state.close)) return;
    const now = Date.now();
    _deployPending.clear();
    _closePending.clear();
    _claimPending.clear();
    const parseEntry = (entry) => {
      if (typeof entry === "number") return { ts: entry, pid: null };
      if (_isPlainObject(entry))     return { ts: Number(entry.ts ?? 0), pid: entry.pid ?? null };
      return { ts: 0, pid: null };
    };
    for (const [k, raw] of Object.entries(state.deploy || {})) {
      const { ts, pid } = parseEntry(raw);
      if (now - ts < PENDING_TTL_MS && _isPidAlive(pid)) _deployPending.set(k, ts);
    }
    for (const [k, raw] of Object.entries(state.close || {})) {
      const { ts, pid } = parseEntry(raw);
      if (now - ts < PENDING_TTL_MS && _isPidAlive(pid)) _closePending.set(k, ts);
    }
    for (const [k, raw] of Object.entries(state.claim || {})) {
      const { ts, pid } = parseEntry(raw);
      if (now - ts < PENDING_TTL_MS && _isPidAlive(pid)) _claimPending.set(k, ts);
    }
  } catch { /* silent — never block operations */ }
}

async function verifyAccountExists(account) {
  try {
    const pubkey = account instanceof PublicKey ? account : new PublicKey(account);
    const info = await getConnection().getAccountInfo(pubkey, TX_VERIFY_COMMITMENT);
    return !!info;
  } catch (error) {
    log("tx_reconcile_warn", `Account verification failed: ${error.message}`);
    return false;
  }
}

async function verifyPositionOpen(positionAddress, {
  poolAddress = null,
  minBinId = null,
  maxBinId = null,
} = {}) {
  try {
    _positionsCacheAt = 0;
    const refreshed = await getMyPositions({ force: true, silent: true });
    const matching = refreshed?.positions?.find((position) => {
      if (position.position !== positionAddress) return false;
      if (poolAddress && position.pool !== poolAddress) return false;
      if (minBinId != null && position.lower_bin != null && position.lower_bin !== minBinId) return false;
      if (maxBinId != null && position.upper_bin != null && position.upper_bin !== maxBinId) return false;
      return true;
    });
    return !!matching;
  } catch (error) {
    log("tx_reconcile_warn", `Open-position verification failed for ${positionAddress.slice(0, 8)}: ${error.message}`);
    return false;
  }
}

// P1: Retry up to 3 times with 2s delay — RPC indexing lag or account propagation delay
// can cause false-negatives right after a deploy tx confirms on-chain.
async function verifyPositionHasLiquidity(positionAddress, poolAddress) {
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      poolCache.delete(String(poolAddress));
      const pool = await getPool(poolAddress);
      const positionData = await pool.getPosition(new PublicKey(positionAddress));
      const bins = positionData?.positionData?.positionBinData || [];
      if (bins.some((bin) => new BN(bin.positionLiquidity || "0").gt(new BN(0)))) {
        return true;
      }
      if (attempt < 2) {
        log("tx_reconcile_warn", `Liquidity not visible yet for ${positionAddress.slice(0, 8)} (attempt ${attempt + 1}/3) — RPC may still be indexing`);
        await sleep(2000);
      }
    } catch (error) {
      log("tx_reconcile_warn", `Liquidity verification failed for ${positionAddress.slice(0, 8)} (attempt ${attempt + 1}/3): ${error.message}`);
      if (attempt < 2) await sleep(2000);
    }
  }
  return false;
}

async function verifyPositionClosed(positionAddress) {
  try {
    _positionsCacheAt = 0;
    const refreshed = await getMyPositions({ force: true, silent: true });
    return !refreshed?.positions?.some((position) => position.position === positionAddress);
  } catch (error) {
    log("tx_reconcile_warn", `Close verification failed for ${positionAddress.slice(0, 8)}: ${error.message}`);
    return false;
  }
}

async function sendAndConfirmWithReconciliation(tx, signers, {
  label,
  verify = null,
  reconcileDelayMs = TX_RECONCILE_DELAY_MS,
} = {}) {
  const txLabel = label || "transaction";
  try {
    return await sendAndConfirmOnHealthyRpc(tx, signers, txLabel);
  } catch (error) {
    log("tx_ambiguous", `${txLabel} send/confirm failed: ${error.message}. Verifying chain state before treating as failed.`);
    if (typeof verify === "function") {
      await sleep(reconcileDelayMs);
      const reconciled = await verify();
      if (reconciled) {
        const syntheticSignature = `reconciled:${txLabel}:${Date.now()}`;
        log("tx_reconciled", `${txLabel} appears applied on-chain after confirm failure.`);
        return syntheticSignature;
      }
    }
    throw error;
  }
}

// P1: Synthetic reconciliation IDs are not real Solana signatures.
// Use this guard before displaying tx hashes as explorer links or passing to RPC.
export function isSyntheticTxId(sig) {
  return typeof sig === "string" && sig.startsWith("reconciled:");
}

// Returns {has_synthetic_txs: true} if any tx across the given arrays is synthetic.
// Spread into result objects so callers can detect and skip explorer links.
function syntheticFlag(...arrays) {
  return arrays.some(arr => arr?.some?.(isSyntheticTxId)) ? { has_synthetic_txs: true } : {};
}

const LPAGENT_API = "https://api.lpagent.io/open-api/v1";

async function fetchLpAgentOpenPositions(walletAddress) {
  if (!process.env.LPAGENT_API_KEY) return {};

  _apiCircuitCheck("lpagent");
  const url = `${LPAGENT_API}/lp-positions/opening?owner=${walletAddress}`;
  try {
    const res = await fetch(url, {
      headers: {
        "x-api-key": process.env.LPAGENT_API_KEY,
      },
    });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      log("lpagent_api", `HTTP ${res.status} for owner ${walletAddress.slice(0, 8)}: ${body.slice(0, 160)}`);
      _apiCircuitFailure("lpagent");
      return {};
    }
    const data = await res.json();
    const positions = data?.data || [];
    const byAddress = {};
    for (const p of positions) {
      const addr = p.position || p.id || p.tokenId;
      if (addr) byAddress[addr] = p;
    }
    _apiCircuitSuccess("lpagent");
    return byAddress;
  } catch (e) {
    log("lpagent_api", `Fetch error for owner ${walletAddress.slice(0, 8)}: ${e.message}`);
    _apiCircuitFailure("lpagent");
    return {};
  }
}

// ─── Fetch DLMM PnL API for all positions in a pool ────────────
async function fetchDlmmPnlForPool(poolAddress, walletAddress) {
  _apiCircuitCheck("meteora_pnl");
  const url = `https://dlmm.datapi.meteora.ag/positions/${poolAddress}/pnl?user=${walletAddress}&status=open&pageSize=100&page=1`;
  try {
    const res = await fetch(url);
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      log("pnl_api", `HTTP ${res.status} for pool ${poolAddress.slice(0, 8)}: ${body.slice(0, 120)}`);
      _apiCircuitFailure("meteora_pnl");
      return {};
    }
    const data = await res.json();
    const positions = data.positions || data.data || [];
    if (positions.length === 0) {
      log("pnl_api", `No positions returned for pool ${poolAddress.slice(0, 8)} — keys: ${Object.keys(data).join(", ")}`);
    }
    const byAddress = {};
    for (const p of positions) {
      const addr = p.positionAddress || p.address || p.position;
      if (addr) byAddress[addr] = p;
    }
    _apiCircuitSuccess("meteora_pnl");
    return byAddress;
  } catch (e) {
    log("pnl_api", `Fetch error for pool ${poolAddress.slice(0, 8)}: ${e.message}`);
    _apiCircuitFailure("meteora_pnl");
    return {};
  }
}

// ─── Get Position PnL (Meteora API) ─────────────────────────────
export async function getPositionPnl({ pool_address, position_address }) {
  pool_address = normalizeMint(pool_address);
  position_address = normalizeMint(position_address);
  const walletAddress = getWallet().publicKey.toString();
  if (shouldUseLpAgentRelay()) {
    try {
      const payload = await fetchOpenPositionsFromMeridian({
        walletAddress,
        agentId: getAgentIdForRequests(),
      });
      const p = payload?.positions?.find((position) => position.position === position_address);
      if (p) {
        // P2: Pass through quality fields already computed by getMyPositions relay path.
        return {
          pnl_usd:             p.pnl_usd,
          pnl_pct:             p.pnl_pct,
          pnl_pct_derived:     p.pnl_pct_derived ?? null,
          pnl_pct_diff:        p.pnl_pct_diff ?? null,
          pnl_pct_suspicious:  p.pnl_pct_suspicious ?? false,
          current_value_usd:   p.total_value_usd,
          unclaimed_fee_usd:   p.unclaimed_fees_usd,
          all_time_fees_usd:   p.collected_fees_usd,
          fee_per_tvl_24h:     p.fee_per_tvl_24h,
          in_range:            p.in_range,
          lower_bin:           p.lower_bin,
          upper_bin:           p.upper_bin,
          active_bin:          p.active_bin,
          age_minutes:         p.age_minutes,
          data_quality:        p.data_quality ?? "complete",
          pnl_source:          "relay_api",
          pnl_confidence:      p.data_quality === "portfolio_only" ? "low" : "high",
          request_id:          payload?.requestId || null,
        };
      }
      log("pnl_warn", "Relay positions API did not include requested position; falling back to Meteora PnL path");
    } catch (error) {
      log("pnl_warn", `Relay PnL lookup failed; falling back to Meteora PnL path: ${error.message}`);
    }
  }
  try {
    const byAddress = await fetchDlmmPnlForPool(pool_address, walletAddress);
    const p = byAddress[position_address];
    if (!p) return { error: "Position not found in PnL API" };

    const unclaimedUsd    = parseFloat(p.unrealizedPnl?.unclaimedFeeTokenX?.usd || 0) + parseFloat(p.unrealizedPnl?.unclaimedFeeTokenY?.usd || 0);
    const currentValueUsd = parseFloat(p.unrealizedPnl?.balances || 0);

    // P2: Align PnL integrity fields with getMyPositions output.
    const _rawPnlPct = parseFloat(p.pnlPctChange ?? 0);
    const pnlPct = Number.isFinite(_rawPnlPct) ? _rawPnlPct : null;
    const derivedPnlPct = Number.isFinite(parseFloat(p.pnlUsd)) && currentValueUsd > 0
      ? parseFloat(p.pnlUsd) / currentValueUsd * 100
      : null;
    const pnlDiff = pnlPct != null && derivedPnlPct != null ? Math.abs(pnlPct - derivedPnlPct) : null;
    const hasFullData = p.lowerBinId != null && p.upperBinId != null;

    return {
      pnl_usd:             Math.round((p.pnlUsd ?? 0) * 100) / 100,
      pnl_pct:             pnlPct != null ? Math.round(pnlPct * 100) / 100 : null,
      pnl_pct_derived:     derivedPnlPct != null ? Math.round(derivedPnlPct * 100) / 100 : null,
      pnl_pct_diff:        pnlDiff != null ? Math.round(pnlDiff * 100) / 100 : null,
      pnl_pct_suspicious:  pnlDiff != null && pnlDiff > (config.management.pnlSanityMaxDiffPct ?? 5),
      current_value_usd:   Math.round(currentValueUsd * 100) / 100,
      unclaimed_fee_usd:   Math.round(unclaimedUsd * 100) / 100,
      all_time_fees_usd:   Math.round(parseFloat(p.allTimeFees?.total?.usd || 0) * 100) / 100,
      fee_per_tvl_24h:     Math.round(parseFloat(p.feePerTvl24h || 0) * 100) / 100,
      in_range:            !p.isOutOfRange,
      lower_bin:           p.lowerBinId      ?? null,
      upper_bin:           p.upperBinId      ?? null,
      active_bin:          p.poolActiveBinId ?? null,
      age_minutes:         p.createdAt ? Math.floor((Date.now() - p.createdAt * 1000) / 60000) : null,
      data_quality:        hasFullData ? "complete" : "portfolio_only",
      pnl_source:          "meteora_api",
      pnl_confidence:      hasFullData ? "high" : "low",
    };
  } catch (error) {
    log("pnl_error", error.message);
    return { error: error.message };
  }
}

function safeNum(value) {
  const n = parseFloat(value ?? 0);
  return Number.isFinite(n) ? n : 0;
}

function normalizeRelayPosition(position) {
  if (!position || typeof position !== "object") return position;
  if (!config.management.solMode) return position;

  const totalValueNative = position.total_value_native ?? position.total_value_usd;
  const unclaimedFeesNative = position.unclaimed_fees_native ?? position.unclaimed_fees_usd;
  const collectedFeesNative = position.collected_fees_native ?? position.collected_fees_usd;
  const pnlNative = position.pnl_native ?? position.pnl_usd;
  const derivedPnlPct = position.pnl_pct_derived_native ?? position.pnl_pct_derived;

  return {
    ...position,
    total_value_usd: totalValueNative,
    unclaimed_fees_usd: unclaimedFeesNative,
    collected_fees_usd: collectedFeesNative,
    pnl_usd: pnlNative,
    pnl_pct_derived: derivedPnlPct,
  };
}

function deriveOpenPnlPct(binData, solMode = false) {
  if (!binData) return null;

  const deposit = solMode
    ? safeNum(binData.allTimeDeposits?.total?.sol)
    : safeNum(binData.allTimeDeposits?.total?.usd);
  if (deposit <= 0) return null;

  const balances = solMode
    ? safeNum(binData.unrealizedPnl?.balancesSol)
    : safeNum(binData.unrealizedPnl?.balances);
  const unclaimedFees = solMode
    ? safeNum(binData.unrealizedPnl?.unclaimedFeeTokenX?.amountSol) + safeNum(binData.unrealizedPnl?.unclaimedFeeTokenY?.amountSol)
    : safeNum(binData.unrealizedPnl?.unclaimedFeeTokenX?.usd) + safeNum(binData.unrealizedPnl?.unclaimedFeeTokenY?.usd);
  const withdrawals = solMode
    ? safeNum(binData.allTimeWithdrawals?.total?.sol)
    : safeNum(binData.allTimeWithdrawals?.total?.usd);
  const fees = solMode
    ? safeNum(binData.allTimeFees?.total?.sol)
    : safeNum(binData.allTimeFees?.total?.usd);

  const pnl = balances + unclaimedFees + withdrawals + fees - deposit;
  return (pnl / deposit) * 100;
}

function deriveLpAgentPnlPct(lpData, solMode = false) {
  if (!lpData) return null;
  const deposit = solMode ? safeNum(lpData.inputNative) : safeNum(lpData.inputValue);
  if (deposit <= 0) return null;

  const currentValue = solMode ? safeNum(lpData.valueNative) : safeNum(lpData.value);
  const unclaimedFees = solMode ? safeNum(lpData.unCollectedFeeNative) : safeNum(lpData.unCollectedFee);
  const pnl = currentValue + unclaimedFees - deposit;
  return (pnl / deposit) * 100;
}

async function fetchOpenPositionsFromMeridian({ walletAddress, agentId }) {
  _apiCircuitCheck("meridian_relay");
  const search = new URLSearchParams({
    owner: walletAddress,
    agentId: agentId || "agent-local",
  });
  try {
    const payload = await agentMeridianJson(`/positions/open?${search.toString()}`, {
      headers: getAgentMeridianHeaders(),
      retry: {
        maxElapsedMs: 30_000,
        perAttemptTimeoutMs: 10_000,
      },
    });
    _apiCircuitSuccess("meridian_relay");
    return {
      ...payload,
      positions: Array.isArray(payload?.positions)
        ? payload.positions.map((position) => normalizeRelayPosition(position))
        : [],
    };
  } catch (e) {
    _apiCircuitFailure("meridian_relay");
    throw e;
  }
}

// ─── Get My Positions ──────────────────────────────────────────
export async function getMyPositions({ force = false, silent = false } = {}) {
  if (!force && _positionsCache) {
    const age = Date.now() - _positionsCacheAt;
    const hasNearEdge = _positionsCache.positions?.some(p =>
      p.lower_bin != null && p.upper_bin != null && p.active_bin != null &&
      (p.active_bin <= p.lower_bin + 2 || p.active_bin >= p.upper_bin - 2)
    );
    // P2: portfolio_only positions have no bin data — we can't tell if they're near edge.
    // Use short TTL to avoid staying stale when the real state is unknown.
    const hasWeakData = _positionsCache.positions?.some(p => p.data_quality !== "complete");
    const ttl = (hasNearEdge || hasWeakData) ? POSITIONS_NEAR_EDGE_CACHE_TTL : POSITIONS_CACHE_TTL;
    if (age < ttl) return _positionsCache;
  }
  if (_positionsInflight) return _positionsInflight;

  let walletAddress;
  try {
    walletAddress = getWallet().publicKey.toString();
  } catch {
    return { wallet: null, total_positions: 0, positions: [], error: "Wallet not configured" };
  }

  _positionsInflight = (async () => { try {
    if (shouldUseLpAgentRelay()) {
      try {
        if (!silent) log("positions", "Fetching open positions via Agent Meridian relay...");
        const result = await fetchOpenPositionsFromMeridian({
          walletAddress,
          agentId: getAgentIdForRequests(),
        });
        const normalizedPositions = Array.isArray(result.positions) ? result.positions : [];
        syncOpenPositions(normalizedPositions.map((p) => p.position));
        _positionsCache = {
          wallet: walletAddress,
          total_positions: Number(result.total_positions || 0),
          positions: normalizedPositions,
          request_id: result.requestId || null,
        };
        _positionsCacheAt = Date.now();
        return _positionsCache;
      } catch (error) {
        log("positions_warn", `Agent Meridian relay failed; falling back to Meteora/local positions path: ${error.message}`);
      }
    }

    // Portfolio API discovers open pools/positions for this wallet.
    // Detailed range data stays on Meteora PnL API; value/PnL can be overridden by LPAgent below.
    if (!silent) log("positions", "Fetching portfolio via Meteora portfolio API...");
    _apiCircuitCheck("meteora_portfolio");
    const portfolioUrl = `https://dlmm.datapi.meteora.ag/portfolio/open?user=${walletAddress}`;
    let res;
    try {
      res = await fetch(portfolioUrl);
    } catch (e) {
      _apiCircuitFailure("meteora_portfolio");
      throw e;
    }
    if (!res.ok) {
      _apiCircuitFailure("meteora_portfolio");
      throw new Error(`Portfolio API ${res.status}: ${await res.text().catch(() => "")}`);
    }
    _apiCircuitSuccess("meteora_portfolio");
    const portfolio = await res.json();

    const pools = portfolio.pools || [];
    log("positions", `Found ${pools.length} pool(s) with open positions`);

    // Fetch bin data (lowerBinId, upperBinId, poolActiveBinId) for all pools in parallel
    // Needed for rules 3 & 4 (active_bin vs upper_bin comparison)
    const binDataByPool = {};
    const pnlMaps = await Promise.all(pools.map(pool => fetchDlmmPnlForPool(pool.poolAddress, walletAddress)));
    pools.forEach((pool, i) => { binDataByPool[pool.poolAddress] = pnlMaps[i]; });
    const lpAgentByPosition = await fetchLpAgentOpenPositions(walletAddress);

    const positions = [];
    for (const pool of pools) {
      for (const positionAddress of (pool.listPositions || [])) {
        const tracked = getTrackedPosition(positionAddress);
        const isOOR = pool.outOfRange || pool.positionsOutOfRange?.includes(positionAddress);

        if (isOOR) markOutOfRange(positionAddress);
        else markInRange(positionAddress);

        // Bin data: from supplemental PnL call (OOR) or tracked state (in-range)
        const binData = binDataByPool[pool.poolAddress]?.[positionAddress];
        if (!binData) {
          log("positions_warn", `PnL API missing data for ${positionAddress.slice(0, 8)} in pool ${pool.poolAddress.slice(0, 8)} — using portfolio only for open-position discovery`);
        }
        const lowerBin  = binData?.lowerBinId      ?? tracked?.bin_range?.min ?? null;
        const upperBin  = binData?.upperBinId      ?? tracked?.bin_range?.max ?? null;
        const activeBin = binData?.poolActiveBinId ?? tracked?.bin_range?.active ?? null;
        const lpData = lpAgentByPosition[positionAddress] || null;

        const ageFromState = tracked?.deployed_at
          ? Math.floor((Date.now() - new Date(tracked.deployed_at).getTime()) / 60000)
          : null;
        // P2: Use null (not 0) when API doesn't send percent — prevents hiding real loss/gain
        // as zero and corrupting PnL sanity check (pnlPctDiff would always be 0 vs derived).
        const _rawReportedPct = lpData
          ? (config.management.solMode ? lpData.pnl?.percentNative : lpData.pnl?.percent)
          : binData
            ? (config.management.solMode ? binData.pnlSolPctChange : binData.pnlPctChange)
            : null;
        const _parsedReportedPnlPct = _rawReportedPct == null ? null : parseFloat(_rawReportedPct);
        const reportedPnlPct = Number.isFinite(_parsedReportedPnlPct) ? _parsedReportedPnlPct : null;
        const _rawDerivedPnlPct = lpData
          ? deriveLpAgentPnlPct(lpData, config.management.solMode)
          : binData
            ? deriveOpenPnlPct(binData, config.management.solMode)
            : null;
        const derivedPnlPct = Number.isFinite(_rawDerivedPnlPct) ? _rawDerivedPnlPct : null;
        const pnlPctDiff = reportedPnlPct != null && derivedPnlPct != null
          ? Math.abs(reportedPnlPct - derivedPnlPct)
          : null;
        const pnlPctSuspicious = pnlPctDiff != null && pnlPctDiff > (config.management.pnlSanityMaxDiffPct ?? 5);
        if (pnlPctSuspicious) {
          log("positions_warn", `Suspicious pnl_pct for ${positionAddress.slice(0, 8)}: reported=${reportedPnlPct.toFixed(2)} derived=${derivedPnlPct.toFixed(2)} diff=${pnlPctDiff.toFixed(2)}`);
        }

        positions.push({
          position:           positionAddress,
          pool:               pool.poolAddress,
          pair:               tracked?.pool_name || `${pool.tokenX}/${pool.tokenY}`,
          base_mint:          pool.tokenXMint,
          lower_bin:          lowerBin,
          upper_bin:          upperBin,
          active_bin:         activeBin,
          in_range:           binData ? !binData.isOutOfRange : !isOOR,
          unclaimed_fees_usd: lpData
            ? Math.round((
                config.management.solMode
                  ? safeNum(lpData.unCollectedFeeNative)
                  : safeNum(lpData.unCollectedFee)
              ) * 10000) / 10000
            : binData
            ? Math.round((
                config.management.solMode
                  ? parseFloat(binData.unrealizedPnl?.unclaimedFeeTokenX?.amountSol || 0) + parseFloat(binData.unrealizedPnl?.unclaimedFeeTokenY?.amountSol || 0)
                  : parseFloat(binData.unrealizedPnl?.unclaimedFeeTokenX?.usd || 0) + parseFloat(binData.unrealizedPnl?.unclaimedFeeTokenY?.usd || 0)
              ) * 10000) / 10000
            : null,
          total_value_usd:    lpData
            ? Math.round((
                config.management.solMode
                  ? safeNum(lpData.valueNative)
                  : safeNum(lpData.value)
              ) * 10000) / 10000
            : binData
            ? Math.round((
                config.management.solMode
                  ? parseFloat(binData.unrealizedPnl?.balancesSol || 0)
                  : parseFloat(binData.unrealizedPnl?.balances || 0)
              ) * 10000) / 10000
            : null,
          // Always-USD fields for internal accounting and lesson recording.
          total_value_true_usd: lpData
            ? Math.round(safeNum(lpData.value) * 10000) / 10000
            : binData
            ? Math.round(parseFloat(binData.unrealizedPnl?.balances || 0) * 10000) / 10000
            : null,
          collected_fees_usd: lpData
            ? Math.round((
                config.management.solMode
                  ? safeNum(lpData.collectedFeeNative)
                  : safeNum(lpData.collectedFee)
              ) * 10000) / 10000
            : binData
            ? Math.round(parseFloat(config.management.solMode ? (binData.allTimeFees?.total?.sol || 0) : (binData.allTimeFees?.total?.usd || 0)) * 10000) / 10000
            : null,
          collected_fees_true_usd: lpData
            ? Math.round(safeNum(lpData.collectedFee) * 10000) / 10000
            : binData
            ? Math.round(parseFloat(binData.allTimeFees?.total?.usd || 0) * 10000) / 10000
            : null,
          pnl_usd:            lpData
            ? Math.round((
                config.management.solMode
                  ? safeNum(lpData.pnl?.valueNative)
                  : safeNum(lpData.pnl?.value)
              ) * 10000) / 10000
            : binData
            ? Math.round(parseFloat(config.management.solMode ? (binData.pnlSol || 0) : (binData.pnlUsd || 0)) * 10000) / 10000
            : null,
          pnl_true_usd:       lpData
            ? Math.round(safeNum(lpData.pnl?.value) * 10000) / 10000
            : binData
            ? Math.round(parseFloat(binData.pnlUsd || 0) * 10000) / 10000
            : null,
          pnl_pct:            reportedPnlPct != null
            ? Math.round(reportedPnlPct * 100) / 100
            : null,
          pnl_pct_derived:    derivedPnlPct != null ? Math.round(derivedPnlPct * 100) / 100 : null,
          pnl_pct_diff:       pnlPctDiff != null ? Math.round(pnlPctDiff * 100) / 100 : null,
          pnl_pct_suspicious: !!pnlPctSuspicious,
          unclaimed_fees_true_usd: lpData
            ? Math.round(safeNum(lpData.unCollectedFee) * 10000) / 10000
            : binData
            ? Math.round((parseFloat(binData.unrealizedPnl?.unclaimedFeeTokenX?.usd || 0) + parseFloat(binData.unrealizedPnl?.unclaimedFeeTokenY?.usd || 0)) * 10000) / 10000
            : null,
          fee_per_tvl_24h:    binData
            ? Math.round(parseFloat(binData.feePerTvl24h || 0) * 100) / 100
            : null,
          age_minutes:        binData?.createdAt ? Math.floor((Date.now() - binData.createdAt * 1000) / 60000) : ageFromState,
          minutes_out_of_range: minutesOutOfRange(positionAddress),
          instruction:        tracked?.instruction ?? null,
          // P2: data_quality flag — manager should avoid automated close/hold decisions
          // when only portfolio data is available (missing lower_bin, upper_bin, pnl_pct).
          data_quality:       binData ? "complete" : "portfolio_only",
        });
      }
    }

    const result = { wallet: walletAddress, total_positions: positions.length, positions, data_fetched_at: new Date().toISOString() };
    syncOpenPositions(positions.map(p => p.position));
    _positionsCache = result;
    _positionsCacheAt = Date.now();
    return result;
  } catch (error) {
    log("positions_error", `Portfolio fetch failed: ${error.stack || error.message}`);
    return { wallet: walletAddress, total_positions: 0, positions: [], error: error.message };
  } finally {
    _positionsInflight = null;
  }
  })();
  return _positionsInflight;
}

// ─── Get Positions for Any Wallet ─────────────────────────────
export async function getWalletPositions({ wallet_address }) {
  try {
    const DLMM_PROGRAM = new PublicKey("LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo");

    const accounts = await getConnection().getProgramAccounts(DLMM_PROGRAM, {
      filters: [{ memcmp: { offset: 40, bytes: new PublicKey(wallet_address).toBase58() } }],
    });

    if (accounts.length === 0) {
      return { wallet: wallet_address, total_positions: 0, positions: [] };
    }

    const raw = accounts.map((acc) => ({
      position: acc.pubkey.toBase58(),
      pool: new PublicKey(acc.account.data.slice(8, 40)).toBase58(),
    }));

    // Enrich with PnL API
    const uniquePools = [...new Set(raw.map((r) => r.pool))];
    const pnlMaps = await Promise.all(uniquePools.map((pool) => fetchDlmmPnlForPool(pool, wallet_address)));
    const pnlByPool = {};
    uniquePools.forEach((pool, i) => { pnlByPool[pool] = pnlMaps[i]; });

    const positions = raw.map((r) => {
      const p = pnlByPool[r.pool]?.[r.position] || null;

      return {
        position:           r.position,
        pool:               r.pool,
        lower_bin:          p?.lowerBinId      ?? null,
        upper_bin:          p?.upperBinId      ?? null,
        active_bin:         p?.poolActiveBinId ?? null,
        in_range:           p ? !p.isOutOfRange : null,
        unclaimed_fees_usd: Math.round((p ? (parseFloat(p.unrealizedPnl?.unclaimedFeeTokenX?.usd || 0) + parseFloat(p.unrealizedPnl?.unclaimedFeeTokenY?.usd || 0)) : 0) * 100) / 100,
        total_value_usd:    Math.round((p ? parseFloat(p.unrealizedPnl?.balances || 0) : 0) * 100) / 100,
        pnl_usd:            Math.round((p?.pnlUsd ?? 0) * 100) / 100,
        pnl_pct:            Math.round((p?.pnlPctChange ?? 0) * 100) / 100,
        age_minutes:        p?.createdAt ? Math.floor((Date.now() - p.createdAt * 1000) / 60000) : null,
      };
    });

    return { wallet: wallet_address, total_positions: positions.length, positions };
  } catch (error) {
    log("wallet_positions_error", error.message);
    return { wallet: wallet_address, total_positions: 0, positions: [], error: error.message };
  }
}

// ─── Search Pools by Query ─────────────────────────────────────
export async function searchPools({ query, limit = 10 }) {
  const url = `https://dlmm.datapi.meteora.ag/pools?query=${encodeURIComponent(query)}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Pool search API error: ${res.status} ${res.statusText}`);
  const data = await res.json();
  const pools = (Array.isArray(data) ? data : data.data || []).slice(0, limit);
  return {
    query,
    total: pools.length,
    pools: pools.map((p) => ({
      pool: p.address || p.pool_address,
      name: p.name,
      bin_step: p.bin_step ?? p.dlmm_params?.bin_step,
      fee_pct: p.base_fee_percentage ?? p.fee_pct,
      tvl: p.liquidity,
      volume_24h: p.trade_volume_24h,
      token_x: { symbol: p.mint_x_symbol ?? p.token_x?.symbol, mint: p.mint_x ?? p.token_x?.address },
      token_y: { symbol: p.mint_y_symbol ?? p.token_y?.symbol, mint: p.mint_y ?? p.token_y?.address },
    })),
  };
}

// ─── Claim Fees ────────────────────────────────────────────────
export async function claimFees({ position_address }) {
  position_address = normalizeMint(position_address);
  if (process.env.DRY_RUN === "true") {
    return { dry_run: true, would_claim: position_address, message: "DRY RUN — no transaction sent" };
  }

  const tracked = getTrackedPosition(position_address);
  if (tracked?.closed) {
    return { success: false, error: "Position already closed — fees were claimed during close" };
  }

  // P1: Claim pending lock — prevents duplicate claim attempt on same position.
  // Atomic fs lock + Map check-and-set (same TOCTOU-safe pattern as deployPosition).
  const _claimFsLock = _acquireFsLock(`claim:${position_address}`);
  if (!_claimFsLock.acquired) {
    return { success: false, error: "Claim already in progress for this position — lock held by another process." };
  }
  _reloadPendingFromDisk();
  if (_claimPending.has(position_address) || _closePending.has(position_address)) {
    _releaseFsLock(_claimFsLock);
    return { success: false, error: "Claim/close already in progress for this position — wait for current operation to complete." };
  }
  _claimPending.set(position_address, Date.now());
  _savePendingState();
  _releaseFsLock(_claimFsLock);

  try {
    log("claim", `Claiming fees for position: ${position_address}`);
    const wallet = getWallet();
    const poolAddress = await lookupPoolForPosition(position_address, wallet.publicKey.toString());
    // Clear cached pool so SDK loads fresh position fee state
    poolCache.delete(poolAddress.toString());
    const pool = await getPool(poolAddress);

    const positionData = await pool.getPosition(new PublicKey(position_address));
    const txs = await pool.claimSwapFee({
      owner: wallet.publicKey,
      position: positionData,
    });

    if (!txs || txs.length === 0) {
      return { success: false, error: "No fees to claim — transaction is empty" };
    }

    const txHashes = [];
    for (const [index, tx] of txs.entries()) {
      const txHash = await sendAndConfirmWithReconciliation(tx, [wallet], {
        label: `claim:${position_address.slice(0, 8)}:${index + 1}`,
      });
      txHashes.push(txHash);
    }
    log("claim", `SUCCESS txs: ${txHashes.join(", ")}`);
    _positionsCacheAt = 0; // invalidate cache after claim
    recordClaim(position_address);

    return { success: true, position: position_address, txs: txHashes, base_mint: pool.lbPair.tokenXMint.toString(), ...syntheticFlag(txHashes) };
  } catch (error) {
    log("claim_error", error.message);
    return { success: false, error: error.message };
  } finally {
    _claimPending.delete(position_address);
    _savePendingState();
  }
}

// ─── Close Position ────────────────────────────────────────────
export async function closePosition({ position_address, reason }) {
  position_address = normalizeMint(position_address);
  if (process.env.DRY_RUN === "true") {
    return { dry_run: true, would_close: position_address, message: "DRY RUN — no transaction sent" };
  }

  const tracked = getTrackedPosition(position_address);

  // P1: Close pending lock — prevents duplicate close attempt to same position.
  // Atomic fs lock + Map check-and-set (same TOCTOU-safe pattern as deployPosition).
  const _closeFsLock = _acquireFsLock(`close:${position_address}`);
  if (!_closeFsLock.acquired) {
    return {
      success: false,
      error: "Close already in progress for this position — lock held by another process.",
    };
  }
  _reloadPendingFromDisk();
  if (_closePending.has(position_address)) {
    _releaseFsLock(_closeFsLock);
    return {
      success: false,
      error: "Close already in progress for this position — wait for current close to complete.",
    };
  }
  _closePending.set(position_address, Date.now());
  _savePendingState();
  _releaseFsLock(_closeFsLock);

  try {
    log("close", `Closing position: ${position_address}`);
    const wallet = getWallet();
    const poolAddress = await lookupPoolForPosition(position_address, wallet.publicKey.toString());
    const poolMeta = await getPoolMetadata(poolAddress);
    if (shouldUseLpAgentRelay()) {
      let relaySubmitted = false;
      try {
      const pool = await getPool(poolAddress);
      const relayAllowedDebitMints = [
        pool.lbPair.tokenXMint.toString(),
        pool.lbPair.tokenYMint.toString(),
        config.tokens.SOL,
      ];
      const livePositions = await getMyPositions({ force: true, silent: true });
      const livePosition = livePositions?.positions?.find((position) => position.position === position_address);
      // P1: Refuse relay close if bin range is completely unknown — extreme fallback
      // (-887272/887272) could cause the relay to generate a dangerously wide transaction.
      const _relayFromBin = livePosition?.lower_bin ?? tracked?.bin_range?.min;
      const _relayToBin   = livePosition?.upper_bin ?? tracked?.bin_range?.max;
      if (_relayFromBin == null || _relayToBin == null) {
        throw new Error(
          `Cannot close safely via relay: bin range unknown for position ${position_address.slice(0, 8)}. ` +
          `Neither live portfolio nor state registry has lower/upper bin. ` +
          `Try closing manually or wait for portfolio API to sync.`
        );
      }
      const closeFromBinId = _relayFromBin;
      const closeToBinId   = _relayToBin;
      // P1: Determine close output based on which token is SOL — not hard-coded to token1.
      // allToken0 if tokenX is SOL, allToken1 if tokenY is SOL.
      const _closeTokenXMint = pool.lbPair.tokenXMint.toString();
      const _closeTokenYMint = pool.lbPair.tokenYMint.toString();
      const SOL_MINT = "So11111111111111111111111111111111111111112";
      let closeOutput;
      if (_closeTokenXMint === SOL_MINT) {
        closeOutput = "allToken0";
      } else if (_closeTokenYMint === SOL_MINT) {
        closeOutput = "allToken1";
      } else {
        throw new Error(
          `Cannot determine close output: neither tokenX (${_closeTokenXMint.slice(0, 8)}) ` +
          `nor tokenY (${_closeTokenYMint.slice(0, 8)}) is SOL. Cannot auto-close to SOL.`
        );
      }

      // P0: Cap relay close slippage at 500 bps (5%) max — 5000 bps (50%) is dangerously high.
      // P1: Validate before clamp so NaN config is caught before Math.min/max silently passes NaN.
      // Configurable via config.management.closeSlippageBps, default 300 bps (3%).
      const _rawCloseSlippageBps = Number(config.management?.closeSlippageBps ?? 300);
      if (!Number.isFinite(_rawCloseSlippageBps)) {
        throw new Error("Invalid closeSlippageBps — must be a finite number.");
      }
      const closeSlippageBps = Math.min(Math.max(1, _rawCloseSlippageBps), 500);

      const order = await agentMeridianJson("/execution/zap-out/order", {
        method: "POST",
        headers: getAgentMeridianHeaders({ json: true }),
        body: JSON.stringify({
          agentId: getAgentIdForRequests(),
          idempotencyKey: `close:${position_address}:${tracked?.deployed_at || "unknown"}`,
          positionId: position_address,
          owner: wallet.publicKey.toString(),
          bps: 10000,
          slippageBps: closeSlippageBps,
          output: closeOutput,
          provider: "OKX",
          type: "meteora",
          fromBinId: closeFromBinId,
          toBinId: closeToBinId,
        }),
      });

      const closeUnsigned = order?.order?.transactions?.close || [];
      const swapUnsigned = order?.order?.transactions?.swap || [];
      if (closeUnsigned.length + swapUnsigned.length === 0) {
        throw new Error("LPAgent close order returned no transactions. Check the position, selected output, and relay order response.");
      }

      // P1: Dynamic maxSolLoss — 3% of deployed position size, capped at 0.05 SOL.
      // Fixed 0.05 was too tight for large positions and too loose for small ones.
      const _deployedSol = Number(tracked?.amount_sol ?? config.management?.deployAmountSol ?? 0.5);
      const _dynSolLoss  = _deployedSol * 0.03;
      const closeMaxSolLoss = Number.isFinite(_dynSolLoss) && _dynSolLoss > 0
        ? Math.min(_dynSolLoss, 0.05)
        : 0.05;

      const closeSigned = await signAndSimulateRelayTransactions(closeUnsigned, wallet, {
        label: "zap-out close",
        allowedDebitMints: relayAllowedDebitMints,
        maxSolLoss: closeMaxSolLoss,
        requiredStaticAccounts: [wallet.publicKey.toString(), position_address],
      });
      const swapSigned = await signAndSimulateRelayTransactions(swapUnsigned, wallet, {
        label: "zap-out swap",
        allowedDebitMints: relayAllowedDebitMints,
        maxSolLoss: closeMaxSolLoss,
        requiredStaticAccounts: [wallet.publicKey.toString()],
      });

      relaySubmitted = true;
      const submit = await agentMeridianJson("/execution/zap-out/submit", {
        method: "POST",
        headers: getAgentMeridianHeaders({ json: true }),
        body: JSON.stringify({
          requestId: order.requestId,
          lastValidBlockHeight: order?.order?.lastValidBlockHeight,
          transactions: {
            close: closeSigned,
            swap: swapSigned,
          },
        }),
      });

      const claimTxHashes = [];
      const closeTxHashes = normalizeExecutionSignatures(submit);
      const txHashes = [...claimTxHashes, ...closeTxHashes];

      await new Promise((resolve) => setTimeout(resolve, 5000));
      _positionsCacheAt = 0;

      let closedConfirmed = false;
      for (let attempt = 0; attempt < 4; attempt++) {
        try {
          const refreshed = await getMyPositions({ force: true, silent: true });
          const stillOpen = refreshed?.positions?.some((p) => p.position === position_address);
          if (!stillOpen) {
            closedConfirmed = true;
            break;
          }
          log("close_warn", `Relay close still appears open after submit (attempt ${attempt + 1}/4)`);
        } catch (e) {
          log("close_warn", `Relay close verification failed (attempt ${attempt + 1}/4): ${e.message}`);
        }
        if (attempt < 3) await new Promise((resolve) => setTimeout(resolve, 3000));
      }

      if (!closedConfirmed) {
        // P1: Tx was already submitted — don't return success:false which implies a hard failure.
        // Return a distinct status so the caller knows not to retry the close.
        return {
          success: null,
          status: "submitted_unconfirmed",
          warning: "Close tx submitted but position still appears open in portfolio API — may still be settling.",
          position: position_address,
          pool: poolAddress,
          close_txs: closeTxHashes,
          txs: txHashes,
        };
      }

      recordClose(position_address, reason || "agent decision");

      if (tracked) {
        const deployedAt = new Date(tracked.deployed_at).getTime();
        const minutesHeld = Math.floor((Date.now() - deployedAt) / 60000);
        let minutesOOR = 0;
        if (tracked.out_of_range_since) {
          minutesOOR = Math.floor((Date.now() - new Date(tracked.out_of_range_since).getTime()) / 60000);
        }

        let pnlUsd = 0;
        let pnlPct = 0;
        let finalValueUsd = 0;
        let initialUsd = 0;
        let feesUsd = tracked.total_fees_claimed_usd || 0;
        try {
          const closedUrl = `https://dlmm.datapi.meteora.ag/positions/${poolAddress}/pnl?user=${wallet.publicKey.toString()}&status=closed&pageSize=50&page=1`;
          for (let attempt = 0; attempt < 6; attempt++) {
            const res = await fetch(closedUrl);
            if (res.ok) {
              const data = await res.json();
              const posEntry = (data.positions || []).find((entry) => entry.positionAddress === position_address);
              if (posEntry) {
                pnlUsd = parseFloat(posEntry.pnlUsd || 0);
                pnlPct = parseFloat(posEntry.pnlPctChange || 0);
                finalValueUsd = parseFloat(posEntry.allTimeWithdrawals?.total?.usd || 0);
                initialUsd = parseFloat(posEntry.allTimeDeposits?.total?.usd || 0);
                feesUsd = parseFloat(posEntry.allTimeFees?.total?.usd || 0) || feesUsd;
                break;
              }
            }
            if (attempt < 5) await new Promise((resolve) => setTimeout(resolve, 5000));
          }
        } catch (e) {
          log("close_warn", `Relay closed PnL fetch failed: ${e.message}`);
        }

        await recordPerformance({
          position: position_address,
          pool: poolAddress,
          pool_name: tracked.pool_name || poolMeta.name || poolAddress.slice(0, 8),
          base_mint: livePosition?.base_mint || null,
          strategy: tracked.strategy,
          bin_range: tracked.bin_range,
          bin_step: tracked.bin_step || null,
          volatility: tracked.volatility ?? null,
          fee_tvl_ratio: tracked.fee_tvl_ratio || null,
          organic_score: tracked.organic_score || null,
          amount_sol: tracked.amount_sol,
          fees_earned_usd: feesUsd,
          final_value_usd: finalValueUsd,
          initial_value_usd: initialUsd,
          minutes_in_range: minutesHeld - minutesOOR,
          minutes_held: minutesHeld,
          close_reason: reason || "agent decision",
        });

        appendDecision({
          type: "close",
          actor: "MANAGER",
          pool: poolAddress,
          pool_name: tracked.pool_name || poolMeta.name || poolAddress.slice(0, 8),
          position: position_address,
          summary: `Relay closed at ${pnlPct.toFixed(2)}%`,
          reason: reason || "agent decision",
          risks: [
            minutesOOR > 0 ? `out of range ${minutesOOR}m` : null,
            tracked.volatility != null ? `volatility ${tracked.volatility}` : null,
          ].filter(Boolean),
          metrics: {
            pnl_usd: pnlUsd,
            pnl_pct: pnlPct,
            fees_usd: feesUsd,
            minutes_held: minutesHeld,
          },
        });

        return {
          success: true,
          relay: true,
          request_id: order.requestId,
          position: position_address,
          pool: poolAddress,
          pool_name: tracked.pool_name || poolMeta.name || null,
          claim_txs: claimTxHashes,
          close_txs: closeTxHashes,
          txs: txHashes,
          pnl_usd: pnlUsd,
          pnl_pct: pnlPct,
          base_mint: livePosition?.base_mint || null,
          ...syntheticFlag(txHashes, claimTxHashes, closeTxHashes),
        };
      }

      appendDecision({
        type: "close",
        actor: "MANAGER",
        pool: poolAddress,
        pool_name: poolMeta.name || poolAddress.slice(0, 8),
        position: position_address,
        summary: "Relay closed position",
        reason: reason || "agent decision",
        metrics: {},
      });

      return {
        success: true,
        relay: true,
        request_id: order.requestId,
        position: position_address,
        pool: poolAddress,
        pool_name: poolMeta.name || null,
        claim_txs: claimTxHashes,
        close_txs: closeTxHashes,
        txs: txHashes,
        base_mint: livePosition?.base_mint || null,
        ...syntheticFlag(txHashes, claimTxHashes, closeTxHashes),
      };
      } catch (relayError) {
        if (relaySubmitted) {
          // P3: Error occurred after relay was already submitted — don't rethrow into
          // the outer catch (which would return success:false) and don't fall through
          // to local close (which would attempt a duplicate close on-chain).
          log("close_warn", `Error after relay submit: ${relayError.message}`);
          return {
            success: null,
            status: "submitted_error_after_submit",
            warning: `Close tx was submitted but an error occurred after: ${relayError.message}`,
            position: position_address,
            pool: poolAddress,
          };
        }
        log("close_warn", `Relay zap-out failed before submit; falling back to local close + Jupiter autoswap: ${relayError.message}`);
      }
    }

    // Clear cached pool so SDK loads fresh position fee state
    poolCache.delete(poolAddress.toString());
    const pool = await getPool(poolAddress);

    const positionPubKey = new PublicKey(position_address);
    const claimTxHashes = [];
    const closeTxHashes = [];

    // ─── Step 1: Claim Fees (to clear account state) ───────────
    const recentlyClaimed = tracked?.last_claim_at && (Date.now() - new Date(tracked.last_claim_at).getTime()) < 60_000;
    try {
      if (recentlyClaimed) {
        log("close", `Step 1: Skipping claim — fees already claimed ${Math.round((Date.now() - new Date(tracked.last_claim_at).getTime()) / 1000)}s ago`);
      } else {
        log("close", `Step 1: Claiming fees for ${position_address}`);
        const positionData = await pool.getPosition(positionPubKey);
        const claimTxs = await pool.claimSwapFee({
          owner: wallet.publicKey,
          position: positionData,
        });
        if (claimTxs && claimTxs.length > 0) {
          for (const [index, tx] of claimTxs.entries()) {
            const claimHash = await sendAndConfirmWithReconciliation(tx, [wallet], {
              label: `close:claim:${position_address.slice(0, 8)}:${index + 1}`,
            });
            claimTxHashes.push(claimHash);
          }
          log("close", `Step 1 OK (claim only): ${claimTxHashes.join(", ")}`);
        }
      }
    } catch (e) {
      log("close_warn", `Step 1 (Claim) failed or nothing to claim: ${e.message}`);
    }

    // ─── Step 2: Remove Liquidity & Close ──────────────────────
    let hasLiquidity = false;
    let closeFromBinId = -887272;
    let closeToBinId = 887272;
    try {
      const positionDataForClose = await pool.getPosition(positionPubKey);
      const processed = positionDataForClose?.positionData;
      if (processed) {
        closeFromBinId = processed.lowerBinId ?? closeFromBinId;
        closeToBinId = processed.upperBinId ?? closeToBinId;
        const bins = Array.isArray(processed.positionBinData) ? processed.positionBinData : [];
        hasLiquidity = bins.some((bin) => new BN(bin.positionLiquidity || "0").gt(new BN(0)));
      }
    } catch (e) {
      log("close_warn", `Could not check liquidity state: ${e.message}`);
    }

    if (hasLiquidity) {
      log("close", `Step 2: Removing liquidity and closing account`);
      const closeTx = await pool.removeLiquidity({
        user: wallet.publicKey,
        position: positionPubKey,
        fromBinId: closeFromBinId,
        toBinId: closeToBinId,
        bps: new BN(10000),
        shouldClaimAndClose: true,
      });

      const closeTxArray = Array.isArray(closeTx) ? closeTx : [closeTx];
      for (const [index, tx] of closeTxArray.entries()) {
        const txHash = await sendAndConfirmWithReconciliation(tx, [wallet], {
          label: `close:remove:${position_address.slice(0, 8)}:${index + 1}`,
          verify: () => verifyPositionClosed(position_address),
        });
        closeTxHashes.push(txHash);
      }
    } else {
      log("close", `Step 2: No position liquidity detected, closing account`);
      const closeTx = await pool.closePosition({
        owner: wallet.publicKey,
        position: { publicKey: positionPubKey },
      });
      const txHash = await sendAndConfirmWithReconciliation(closeTx, [wallet], {
        label: `close:account:${position_address.slice(0, 8)}`,
        verify: () => verifyPositionClosed(position_address),
      });
      closeTxHashes.push(txHash);
    }
    const txHashes = [...claimTxHashes, ...closeTxHashes];
    log("close", `Step 2 OK (close only): ${closeTxHashes.join(", ") || "none"}`);
    log("close", `SUCCESS txs: ${txHashes.join(", ")}`);
    // Wait for RPC to reflect withdrawn balances before returning — prevents
    // agent from seeing zero balance when attempting post-close swap
    await new Promise(r => setTimeout(r, 5000));
    _positionsCacheAt = 0;

    let closedConfirmed = false;
    for (let attempt = 0; attempt < 4; attempt++) {
      try {
        const refreshed = await getMyPositions({ force: true, silent: true });
        const stillOpen = refreshed?.positions?.some((p) => p.position === position_address);
        if (!stillOpen) {
          closedConfirmed = true;
          break;
        }
        log("close_warn", `Position ${position_address} still appears open after close txs (attempt ${attempt + 1}/4)`);
      } catch (e) {
        log("close_warn", `Close verification failed (attempt ${attempt + 1}/4): ${e.message}`);
      }
      if (attempt < 3) await new Promise((r) => setTimeout(r, 3000));
    }

    if (!closedConfirmed) {
      // P1: Txs were sent on-chain — return submitted_unconfirmed, not success:false.
      // Prevents the manager from treating a submitted close as a hard failure
      // and attempting a duplicate close or making wrong decisions.
      return {
        success: null,
        status: "submitted_unconfirmed",
        warning: "Close txs sent but position still appears open in portfolio API — may still be settling.",
        position: position_address,
        pool: poolAddress,
        claim_txs: claimTxHashes,
        close_txs: closeTxHashes,
        txs: txHashes,
      };
    }

    recordClose(position_address, reason || "agent decision");

    // Record performance for learning
    if (tracked) {
      const deployedAt = new Date(tracked.deployed_at).getTime();
      const minutesHeld = Math.floor((Date.now() - deployedAt) / 60000);

      let minutesOOR = 0;
      if (tracked.out_of_range_since) {
        minutesOOR = Math.floor((Date.now() - new Date(tracked.out_of_range_since).getTime()) / 60000);
      }

      const shouldRejectClosedPnl = (pct, closeReasonText) => {
        if (!Number.isFinite(pct)) return false;
        const reasonText = String(closeReasonText || "").toLowerCase();
        const stopLossTriggered = reasonText.includes("stop loss");
        // Meteora sometimes briefly reports absurd closed pnl while the record is settling.
        // Trust legitimate stop-loss disasters, but reject obviously unsettled outliers otherwise.
        return !stopLossTriggered && pct <= -90;
      };

      // Fetch closed PnL from API — authoritative source after withdrawal settles
      let pnlUsd = 0;
      let pnlPct = 0;
      let finalValueUsd = 0;
      let initialUsd = 0;
      let feesUsd = tracked.total_fees_claimed_usd || 0;
      let pnlSource = "closed_api";
      let pnlConfidence = "high";
      try {
        const closedUrl = `https://dlmm.datapi.meteora.ag/positions/${poolAddress}/pnl?user=${wallet.publicKey.toString()}&status=closed&pageSize=50&page=1`;
        for (let attempt = 0; attempt < 6; attempt++) {
          const res = await fetch(closedUrl);
          if (res.ok) {
            const data = await res.json();
            const posEntry = (data.positions || []).find(p => p.positionAddress === position_address);
            if (posEntry) {
              const nextPnlUsd = parseFloat(posEntry.pnlUsd || 0);
              const nextPnlPct = parseFloat(posEntry.pnlPctChange || 0);
              const nextFinalValueUsd = parseFloat(posEntry.allTimeWithdrawals?.total?.usd || 0);
              const nextInitialUsd = parseFloat(posEntry.allTimeDeposits?.total?.usd || 0);
              const nextFeesUsd = parseFloat(posEntry.allTimeFees?.total?.usd || 0) || feesUsd;

              if (shouldRejectClosedPnl(nextPnlPct, reason || tracked?.close_reason)) {
                log("close_warn", `Rejected unsettled closed PnL for ${position_address.slice(0, 8)} on attempt ${attempt + 1}/6: ${nextPnlPct.toFixed(2)}%`);
              } else {
                pnlUsd        = nextPnlUsd;
                pnlPct        = nextPnlPct;
                finalValueUsd = nextFinalValueUsd;
                initialUsd    = nextInitialUsd;
                feesUsd       = nextFeesUsd;
                log("close", `Closed PnL from API: pnl=${pnlUsd.toFixed(2)} USD (${pnlPct.toFixed(2)}%), withdrawn=${finalValueUsd.toFixed(2)}, deposited=${initialUsd.toFixed(2)}`);
                break;
              }
            } else {
              log("close_warn", `Position not found in status=closed response (attempt ${attempt + 1}/6) — may still be settling`);
            }
          }
          if (attempt < 5) await new Promise((r) => setTimeout(r, 5000));
        }
      } catch (e) {
        log("close_warn", `Closed PnL fetch failed: ${e.message}`);
      }
      // Fallback to pre-close cache snapshot if closed API had no data
      if (finalValueUsd === 0) {
        const cachedPos = _positionsCache?.positions?.find(p => p.position === position_address);
        if (cachedPos) {
          pnlUsd        = cachedPos.pnl_true_usd ?? cachedPos.pnl_usd ?? 0;
          pnlPct        = cachedPos.pnl_pct   ?? 0;
          feesUsd       = (cachedPos.collected_fees_true_usd || 0) + (cachedPos.unclaimed_fees_true_usd || 0);
          initialUsd    = tracked.initial_value_usd || 0;
          if (initialUsd > 0) {
            // Keep fallback internally consistent using USD-only cached metrics.
            finalValueUsd = Math.max(0, initialUsd + pnlUsd - feesUsd);
            pnlPct = (pnlUsd / initialUsd) * 100;
          } else {
            finalValueUsd = cachedPos.total_value_true_usd ?? cachedPos.total_value_usd ?? 0;
            initialUsd = Math.max(0, finalValueUsd + feesUsd - pnlUsd);
          }
          pnlSource = "preclose_cache_fallback";
          pnlConfidence = "low";
          log("close_warn", `Using cached pnl fallback because closed API has not settled yet`);
        }
      }

      await recordPerformance({
        position: position_address,
        pool: poolAddress,
        pool_name: tracked.pool_name || poolMeta.name || poolAddress.slice(0, 8),
        base_mint: pool.lbPair.tokenXMint.toString(),
        strategy: tracked.strategy,
        bin_range: tracked.bin_range,
        bin_step: tracked.bin_step || null,
        volatility: tracked.volatility ?? null,
        fee_tvl_ratio: tracked.fee_tvl_ratio || null,
        organic_score: tracked.organic_score || null,
        amount_sol: tracked.amount_sol,
        fees_earned_usd: feesUsd,
        final_value_usd: finalValueUsd,
        initial_value_usd: initialUsd,
        minutes_in_range: minutesHeld - minutesOOR,
        minutes_held: minutesHeld,
        close_reason: reason || "agent decision",
        pnl_source: pnlSource,
        pnl_confidence: pnlConfidence,
      });

      appendDecision({
        type: "close",
        actor: "MANAGER",
        pool: poolAddress,
        pool_name: tracked.pool_name || poolMeta.name || poolAddress.slice(0, 8),
        position: position_address,
        summary: `Closed at ${pnlPct.toFixed(2)}%`,
        reason: reason || "agent decision",
        risks: [
          minutesOOR > 0 ? `out of range ${minutesOOR}m` : null,
          tracked.volatility != null ? `volatility ${tracked.volatility}` : null,
        ].filter(Boolean),
        metrics: {
          pnl_usd: pnlUsd,
          pnl_pct: pnlPct,
          fees_usd: feesUsd,
          minutes_held: minutesHeld,
        },
      });

      return {
        success: true,
        position: position_address,
        pool: poolAddress,
        pool_name: tracked.pool_name || poolMeta.name || null,
        claim_txs: claimTxHashes,
        close_txs: closeTxHashes,
        txs: txHashes,
        pnl_usd: pnlUsd,
        pnl_pct: pnlPct,
        base_mint: pool.lbPair.tokenXMint.toString(),
        ...syntheticFlag(txHashes, claimTxHashes, closeTxHashes),
      };
    }

    appendDecision({
      type: "close",
      actor: "MANAGER",
      pool: poolAddress,
      pool_name: poolMeta.name || poolAddress.slice(0, 8),
      position: position_address,
      summary: "Closed position",
      reason: reason || "agent decision",
      metrics: {},
    });

    return {
      success: true,
      position: position_address,
      pool: poolAddress,
      pool_name: poolMeta.name || null,
      claim_txs: claimTxHashes,
      close_txs: closeTxHashes,
      txs: txHashes,
      base_mint: pool.lbPair.tokenXMint.toString(),
      ...syntheticFlag(txHashes, claimTxHashes, closeTxHashes),
    };
  } catch (error) {
    log("close_error", error.message);
    return { success: false, error: error.message };
  } finally {
    _closePending.delete(position_address);
    _savePendingState();
  }
}

// ─── Helpers ──────────────────────────────────────────────────
async function lookupPoolForPosition(position_address, walletAddress) {
  // Check state registry first (fast path)
  const tracked = getTrackedPosition(position_address);
  if (tracked?.pool) return tracked.pool;

  // Check in-memory positions cache
  const cached = _positionsCache?.positions?.find((p) => p.position === position_address);
  if (cached?.pool) return cached.pool;

  // SDK scan (last resort)
  const { DLMM } = await getDLMM();
  const allPositions = await DLMM.getAllLbPairPositionsByUser(
    getConnection(),
    new PublicKey(walletAddress)
  );

  for (const [lbPairKey, positionData] of Object.entries(allPositions)) {
    for (const pos of positionData.lbPairPositionsData || []) {
      if (pos.publicKey.toString() === position_address) return lbPairKey;
    }
  }

  throw new Error(`Position ${position_address} not found in open positions`);
}
