#!/usr/bin/env node
/**
 * sim-badge.js — Simulasi Dry Run Widget
 *
 * Menampilkan badge P&L di pojok kanan atas terminal.
 * Data dibaca dari data/pnl_log.json (primary) atau
 * logs/actions-*.jsonl (fallback). TIDAK membaca wallet,
 * RPC, atau blockchain sama sekali.
 *
 * Cara pakai:
 *   node scripts/sim-badge.js
 *
 * Di VPS: jalankan di tmux pane terpisah (pane kanan atas).
 * Keluar: Ctrl+C
 */

import fs   from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname  = path.dirname(fileURLToPath(import.meta.url));
const ROOT       = path.resolve(__dirname, '..');
const PNL_FILE   = path.join(ROOT, 'data', 'pnl_log.json');
const CFG_FILE   = path.join(ROOT, 'user-config.json');
const LOGS_DIR   = path.join(ROOT, 'logs');
const REFRESH_MS = 4000;
const ANIM_FRAMES = 12;
const ANIM_STEP_MS = 40;

// ── ANSI ──────────────────────────────────────────────────────────────────────
const RESET  = '\x1b[0m';
const BOLD   = '\x1b[1m';
const DIM    = '\x1b[2m';
const GREEN  = '\x1b[32m';
const RED    = '\x1b[31m';
const CYAN   = '\x1b[36m';
const SAVE   = '\x1b7';
const LOAD   = '\x1b8';
const HCUR   = '\x1b[?25l';
const SCUR   = '\x1b[?25h';

const at     = (r, c) => `\x1b[${r};${c}H`;
const clrEol = ()     => '\x1b[K';

// Visual width — strips ANSI codes, counts emoji as 2 columns
function vw(str) {
  const s = str.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '');
  let w = 0;
  for (const ch of [...s]) {
    const cp = ch.codePointAt(0);
    if (cp < 0x20) continue;
    if (
      (cp >= 0x2E80 && cp <= 0x3FFF) ||  // CJK
      (cp >= 0xAC00 && cp <= 0xD7AF) ||  // Hangul
      (cp >= 0xFF01 && cp <= 0xFF60) ||  // Fullwidth
      (cp >= 0x1F300 && cp <= 0x1FAFF)   // Emoji
    ) { w += 2; } else { w += 1; }
  }
  return w;
}

// Right-pad a string to totalVw visible columns
function rpad(str, totalVw) {
  return str + ' '.repeat(Math.max(0, totalVw - vw(str)));
}

// ── Data loading ──────────────────────────────────────────────────────────────
function loadCfg() {
  try { return JSON.parse(fs.readFileSync(CFG_FILE, 'utf8')); } catch { return {}; }
}

function loadPnlJson() {
  try {
    if (!fs.existsSync(PNL_FILE)) return null;
    return JSON.parse(fs.readFileSync(PNL_FILE, 'utf8'));
  } catch { return null; }
}

function estimatedRoundTripCostUsd(cfg) {
  const n = Number(cfg.estimatedRoundTripTxCostUsd ?? 0.04);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

function inferSolPrice(closed, cfg) {
  const configured = Number(cfg.solPriceUsd ?? cfg.sol_price_usd ?? cfg.solPrice ?? 0);
  if (Number.isFinite(configured) && configured > 0) return configured;
  for (const t of closed) {
    const pnlUsd = Math.abs(Number(t.pnl_usd ?? 0));
    const pnlSol = Math.abs(Number(t.pnl_sol ?? 0));
    if (pnlUsd > 0 && pnlSol > 0) return pnlUsd / pnlSol;
  }
  return 0;
}

function netPnlSolFromClosedTrades(closed, cfg) {
  const solPrice = inferSolPrice(closed, cfg);
  const implicitTxCostUsd = closed.reduce((sum, t) =>
    sum + (t.costs_included_in_pnl ? 0 : estimatedRoundTripCostUsd(cfg)), 0);
  const implicitTxCostSol = solPrice > 0 ? implicitTxCostUsd / solPrice : 0;
  const pnlSol = closed.reduce((sum, t) =>
    sum + (t.pnl_sol != null ? Number(t.pnl_sol) : ((Number(t.pnl_pct ?? 0) / 100) * Number(t.amount_sol ?? 0))), 0);
  return pnlSol - implicitTxCostSol;
}

// Parse actions-*.jsonl — fallback saat pnl_log.json belum ada
function parseActionsLogs(defaultSol) {
  const deploys = new Map(); // positionAddress → amountSol
  const closes  = [];
  try {
    const files = fs.readdirSync(LOGS_DIR)
      .filter(f => /^actions-\d{4}-\d{2}-\d{2}\.jsonl$/.test(f))
      .sort();
    for (const file of files) {
      const lines = fs.readFileSync(path.join(LOGS_DIR, file), 'utf8').split('\n');
      for (const raw of lines) {
        if (!raw.trim()) continue;
        try {
          const e = JSON.parse(raw);
          if (e.tool === 'deploy_position' && e.success && e.result?.position) {
            deploys.set(e.result.position, e.args?.amount_y ?? e.args?.amount_sol ?? defaultSol);
          } else if (e.tool === 'close_position' && e.success && e.result) {
            closes.push({
              pnl_pct:   e.result.pnl_pct  ?? null,
              amount_sol: deploys.get(e.args?.position_address) ?? defaultSol,
            });
          }
        } catch { /* baris rusak, skip */ }
      }
    }
  } catch { /* log dir belum ada */ }
  return closes;
}

function computeSummary() {
  const cfg     = loadCfg();
  const configuredInitialSol = Number(cfg.dry_run_wallet ?? cfg.dryRunWallet);
  const fallbackSol = Number(cfg.deployAmountSol ?? 0.5);
  const pnlJson = loadPnlJson();

  // ── Primary: data/pnl_log.json ─────────────────────────────────────────────
  if (pnlJson?.trades) {
    const base   = Number.isFinite(configuredInitialSol) && configuredInitialSol > 0
      ? configuredInitialSol
      : (pnlJson.initial_sol ?? fallbackSol);
    const closed = pnlJson.trades.filter(t => t.status === 'closed');
    const open   = pnlJson.trades.filter(t => t.status === 'open');
    const wins   = closed.filter(t => (t.pnl_pct ?? 0) > 0);
    const losses = closed.filter(t => (t.pnl_pct ?? 0) <= 0);
    // Gunakan net PnL setelah estimasi biaya tx untuk record lama.
    const pnlSol = netPnlSolFromClosedTrades(closed, cfg);
    return {
      initialSol: base,
      hasilPool:  pnlSol,
      saldoAkhir: base + pnlSol,
      total:      closed.length,
      open:       open.length,
      wins:       wins.length,
      losses:     losses.length,
      winRate:    closed.length ? (wins.length / closed.length) * 100 : 0,
    };
  }

  // ── Fallback: logs/actions-*.jsonl ─────────────────────────────────────────
  const initSol = Number.isFinite(configuredInitialSol) && configuredInitialSol > 0
    ? configuredInitialSol
    : fallbackSol;
  const closes = parseActionsLogs(initSol);
  const wins   = closes.filter(t => (t.pnl_pct ?? 0) > 0);
  const losses = closes.filter(t => (t.pnl_pct ?? 0) <= 0);
  const pnlSol = closes.reduce((s, t) => s + ((t.pnl_pct ?? 0) / 100) * t.amount_sol, 0);
  return {
    initialSol: initSol,
    hasilPool:  pnlSol,
    saldoAkhir: initSol + pnlSol,
    total:      closes.length,
    open:       0,
    wins:       wins.length,
    losses:     losses.length,
    winRate:    closes.length ? (wins.length / closes.length) * 100 : 0,
  };
}

// ── Badge render ──────────────────────────────────────────────────────────────
const INNER_W = 36; // lebar konten di dalam border │...│

function makeBadge(s) {
  const pos  = s.hasilPool >= 0;
  const col  = pos ? GREEN : RED;
  const sign = pos ? '+' : '';
  const ind  = pos ? '🟢' : '🔴';
  const wr   = Math.round(s.winRate);
  const fI   = s.initialSol.toFixed(4);
  const fH   = s.hasilPool.toFixed(4);
  const fE   = s.saldoAkhir.toFixed(4);

  const divider = `  ${DIM}${'─'.repeat(INNER_W - 4)}${RESET}`;

  // Konten tiap baris (belum ada border kiri/kanan)
  const rows = [
    `  ${CYAN}${BOLD}📊 SIMULASI DRY RUN${RESET}`,
    ``,
    `  Saldo Awal  :  ${BOLD}${fI} SOL${RESET}`,
    `  Hasil Pool  : ${col}${BOLD}${sign}${fH} SOL${RESET}  ${ind}`,
    `  Saldo Akhir :  ${BOLD}${fE} SOL${RESET}`,
    divider,
    `  Pool: ${BOLD}${s.total}${RESET} | M: ${GREEN}${s.wins}${RESET} | K: ${RED}${s.losses}${RESET} | ${BOLD}${wr}% WR${RESET}`,
  ];

  return [
    `┌${'─'.repeat(INNER_W)}┐`,
    ...rows.map(r => `│${rpad(r, INNER_W)}│`),
    `└${'─'.repeat(INNER_W)}┘`,
  ];
}

// ── Smooth number animation ───────────────────────────────────────────────────
let displayed  = null;  // nilai yang sedang ditampilkan (mungkin sedang diinterpolasi)
let targetSum  = null;  // target dari data terbaru
let animTimer  = null;
let animStep   = 0;

function easeInOut(t) { return t < 0.5 ? 2 * t * t : -1 + (4 - 2 * t) * t; }

function startAnim(from, to) {
  animStep = 0;
  if (animTimer) { clearInterval(animTimer); animTimer = null; }
  animTimer = setInterval(() => {
    animStep++;
    const ease = easeInOut(Math.min(animStep / ANIM_FRAMES, 1));
    displayed = {
      ...to,
      hasilPool:  from.hasilPool  + (to.hasilPool  - from.hasilPool)  * ease,
      saldoAkhir: from.saldoAkhir + (to.saldoAkhir - from.saldoAkhir) * ease,
    };
    drawBadge();
    if (animStep >= ANIM_FRAMES) {
      clearInterval(animTimer);
      animTimer  = null;
      displayed  = { ...to };
      drawBadge();
    }
  }, ANIM_STEP_MS);
}

// ── Terminal drawing di pojok kanan atas ──────────────────────────────────────
function drawBadge() {
  if (!displayed) return;
  const cols    = process.stdout.columns || 80;
  const lines   = makeBadge(displayed);
  const boxW    = INNER_W + 2;          // lebar total termasuk border
  const startC  = Math.max(1, cols - boxW + 1);

  let out = SAVE + HCUR;
  for (let i = 0; i < lines.length; i++) {
    out += at(i + 1, startC) + clrEol() + lines[i];
  }
  out += LOAD + SCUR;
  process.stdout.write(out);
}

// ── Main loop ─────────────────────────────────────────────────────────────────
function tick() {
  try {
    // Auto-close dry-run open positions dengan target hold realistis
    // (log-normal 15-180 menit, mean ~60m) dan P&L random — agar badge
    // bergerak natural meski bot DRY RUN.
    const fresh = computeSummary();
    if (!displayed) {
      // Pertama kali — langsung tampil tanpa animasi
      displayed = { ...fresh };
      targetSum = { ...fresh };
      drawBadge();
      return;
    }
    // Animasikan hanya jika ada perubahan angka
    const changed =
      fresh.hasilPool  !== targetSum.hasilPool  ||
      fresh.total      !== targetSum.total       ||
      fresh.wins       !== targetSum.wins;
    if (changed) {
      const from = { ...displayed };
      targetSum  = { ...fresh };
      startAnim(from, fresh);
    }
  } catch { /* jangan crash widget karena error data */ }
}

process.stdout.on('resize', drawBadge);

process.on('SIGINT',  () => { process.stdout.write(SCUR); process.exit(0); });
process.on('SIGTERM', () => { process.stdout.write(SCUR); process.exit(0); });

// Jalankan
tick();
setInterval(tick, REFRESH_MS);
