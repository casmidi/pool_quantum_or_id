/**
 * intelligence/helius-provider.js
 * Helius transaction parser & webhook wrapper.
 * 
 * Helius is already used in the main app (env: HELIUS_API_KEY).
 * This module provides structured wallet activity parsing
 * normalized for the scoring engine.
 * 
 * Endpoints used:
 *   GET https://api.helius.xyz/v0/addresses/{address}/transactions
 *   GET https://api.helius.xyz/v0/addresses/{address}/balances
 *   POST https://api.helius.xyz/v0/webhooks
 */

import { rateLimitedFetch } from "./rate-limiter.js";
import { cacheWrap, cacheSet } from "./cache-manager.js";
import { log } from "../logger.js";

const BASE_URL = "https://api.helius.xyz/v0";
const CACHE_TTL_TXN = 3 * 60 * 1000;   // 3 min
const CACHE_TTL_BAL = 1 * 60 * 1000;   // 1 min

const API_KEY = process.env.HELIUS_API_KEY || "";
const RPC_URL = process.env.RPC_URL || "";

function apiUrl(path, params = {}) {
  const url = new URL(`${BASE_URL}${path}`);
  url.searchParams.set("apiKey", API_KEY);
  for (const [k, v] of Object.entries(params)) {
    if (v != null) url.searchParams.set(k, v);
  }
  return url.toString();
}

function isAvailable() {
  return !!API_KEY;
}

/**
 * Fetch recent transactions for a wallet.
 * @param {string} address — Solana wallet address
 * @param {object} [opts]
 * @param {number} [opts.limit=50] — max transactions
 * @param {string} [opts.type] — filter by type ("SWAP", "DEPOSIT", "WITHDRAWAL")
 * @returns {Array<object>}
 */
export async function fetchWalletTransactions(address, opts = {}) {
  if (!isAvailable()) return [];

  const limit = opts.limit || 50;
  const type = opts.type || null;
  const cacheKey = `helius:txns:${address}:${limit}:${type || "all"}`;

  return cacheWrap(cacheKey, async () => {
    try {
      const params = { limit: String(limit) };
      if (type) params.type = type;

      const result = await rateLimitedFetch("helius", async () => {
        const url = apiUrl(`/addresses/${address}/transactions`, params);
        const res = await fetch(url, { signal: AbortSignal.timeout(10_000) });
        if (!res.ok) return [];
        return res.json();
      });

      if (!Array.isArray(result)) return [];

      // Normalize transactions
      return result.map((tx) => ({
        signature: tx.signature,
        type: tx.type,
        timestamp: tx.timestamp,
        slot: tx.slot,
        fee: tx.fee || 0,
        // LP-specific
        tokenTransfers: (tx.tokenTransfers || []).map((t) => ({
          mint: t.mint,
          symbol: t.symbol,
          amount: parseFloat(t.rawTokenAmount?.tokenAmount || t.amount || 0),
          from: t.fromUserAccount,
          to: t.toUserAccount,
        })),
        // Native SOL transfers
        nativeTransfers: (tx.nativeTransfers || []).map((t) => ({
          amount: t.amount,
          from: t.fromUserAccount,
          to: t.toUserAccount,
        })),
        // Accounts involved
        accountData: tx.accountData?.map((a) => ({
          account: a.account,
          nativeBalanceChange: a.nativeBalanceChange,
        })) || [],
        // Instructions
        instructions: tx.instructions?.length || 0,
        innerInstructions: tx.innerInstructions?.length || 0,
      }));
    } catch (err) {
      log("helius", `fetchWalletTransactions [${address.slice(0, 8)}]: ${err.message}`);
      return [];
    }
  }, { namespace: "helius", ttlMs: CACHE_TTL_TXN });
}

/**
 * Fetch wallet token balances.
 * @param {string} address
 * @returns {Array<object>}
 */
export async function fetchWalletBalances(address) {
  if (!isAvailable()) return [];

  const cacheKey = `helius:balances:${address}`;
  return cacheWrap(cacheKey, async () => {
    try {
      const result = await rateLimitedFetch("helius", async () => {
        const url = apiUrl(`/addresses/${address}/balances`);
        const res = await fetch(url, { signal: AbortSignal.timeout(10_000) });
        if (!res.ok) return [];
        return res.json();
      });

      if (!result?.tokens) return [];
      return result.tokens.map((t) => ({
        mint: t.mint,
        symbol: t.symbol || t.mint?.slice(0, 8),
        amount: parseFloat(t.amount || t.rawTokenAmount?.tokenAmount || 0),
        decimals: t.decimals || 0,
        uiAmount: parseFloat(t.amount || 0) / Math.pow(10, t.decimals || 1),
      }));
    } catch (err) {
      log("helius", `fetchWalletBalances [${address.slice(0, 8)}]: ${err.message}`);
      return [];
    }
  }, { namespace: "helius", ttlMs: CACHE_TTL_BAL });
}

/**
 * Extract LP-relevant metrics from Helius transaction history.
 * @param {string} address
 * @returns {object} LP activity metrics
 */
export async function extractLpMetrics(address) {
  const [txns, balances] = await Promise.all([
    fetchWalletTransactions(address, { limit: 100 }),
    fetchWalletBalances(address),
  ]);

  // Filter LP-related transactions
  const lpTxns = txns.filter(
    (tx) => tx.type === "DEPOSIT" || tx.type === "WITHDRAWAL" || tx.type === "SWAP"
  );

  // Calculate metrics
  const deposits = lpTxns.filter((t) => t.type === "DEPOSIT").length;
  const withdrawals = lpTxns.filter((t) => t.type === "WITHDRAWAL").length;
  const swaps = lpTxns.filter((t) => t.type === "SWAP").length;

  // Unique tokens traded
  const uniqueMints = new Set();
  for (const tx of txns) {
    for (const t of tx.tokenTransfers) {
      uniqueMints.add(t.mint);
    }
  }

  // Recent activity (last 24h)
  const now = Date.now() / 1000;
  const recentTxns = txns.filter((tx) => (now - (tx.timestamp || 0)) < 86400);

  return {
    address,
    totalTransactions: txns.length,
    lpTransactions: lpTxns.length,
    deposits,
    withdrawals,
    swaps,
    uniqueTokens: uniqueMints.size,
    recentActivity24h: recentTxns.length,
    tokenBalances: balances,
    fetchedAt: Date.now(),
    source: "helius",
  };
}

/**
 * Set up a Helius webhook for wallet monitoring.
 * @param {string} webhookUrl — your app's webhook endpoint
 * @param {string[]} walletAddresses — addresses to monitor
 * @returns {object|null}
 */
export async function createWalletWebhook(webhookUrl, walletAddresses) {
  if (!isAvailable()) return null;
  if (!webhookUrl || !walletAddresses?.length) return null;

  try {
    const result = await rateLimitedFetch("helius", async () => {
      const url = apiUrl("/webhooks");
      const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          webhookURL: webhookUrl,
          transactionTypes: ["ANY"],
          accountAddresses: walletAddresses,
          webhookType: "raw",
        }),
        signal: AbortSignal.timeout(10_000),
      });
      if (!res.ok) throw new Error(`Webhook creation failed: ${res.status}`);
      return res.json();
    });
    return result;
  } catch (err) {
    log("helius", `createWalletWebhook error: ${err.message}`);
    return null;
  }
}

export function getHeliusStatus() {
  return {
    name: "Helius",
    available: isAvailable(),
    hasApiKey: isAvailable(),
    authenticated: isAvailable(),
    rpcConfigured: !!RPC_URL,
  };
}
