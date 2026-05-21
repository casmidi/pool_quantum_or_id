# Panduan Strategy — Meridian DLMM LP Bot

> Dokumen ini menjelaskan secara detail bagaimana bot Meridian bekerja, mulai dari cara menemukan pool, cara masuk posisi, sampai cara keluar.

---

## Gambaran Besar

Meridian bukan trading bot biasa. Ini adalah **Liquidity Provider (LP) Agent** di protokol **Meteora DLMM** (Dynamic Liquidity Market Maker) di blockchain Solana. Bot tidak melakukan jual-beli token — bot menaruh likuiditas di dalam pool dan mendapatkan **fee dari setiap transaksi** yang melewati range harga yang kita pasang.

```
Sumber Profit: Fee dari transaksi trader lain yang melewati bin range kita
Risiko Utama:  Impermanent Loss (IL) bila harga bergerak jauh keluar range
```

---

## Alur Kerja Bot (End-to-End)

```
[Setiap 30 menit]
Meteora API → Filter Awal → Enrichment (OKX, Smart Wallets, Narrative) 
→ Hard Filter (Launchpad, Bot Holders) → LLM Evaluasi → Deploy Posisi

[Setiap 10 menit]
Cek posisi aktif → Evaluasi PnL & Kondisi → Close jika trigger terpenuhi
```

---

## FASE 1 — Penemuan Pool (Screening)

### 1.1 Query ke Meteora Discovery API

Bot query ke `https://pool-discovery-api.datapi.meteora.ag` dengan filter:

| Parameter | Nilai | Penjelasan |
|-----------|-------|-----------|
| `pool_type` | `dlmm` | Hanya pool DLMM Meteora |
| `category` | `trending` | Pool yang sedang ramai diperdagangkan |
| `timeframe` | `5m` | Data rolling 5 menit terakhir |
| `tvl` | `$10.000 – $150.000` | Likuiditas tidak terlalu kecil, tidak terlalu besar |
| `volume` | `>= $500` | Ada aktivitas trading nyata |
| `dlmm_bin_step` | `80 – 125` | Range bin yang cocok untuk volatilitas sedang |
| `fee_active_tvl_ratio` | `>= 0.001` | Ada fee terakumulasi (filter minimal) |
| `base_token_organic_score` | `>= 60` | Token tidak dipenuhi bot/wash trade |
| `base_token_holders` | `>= 500` | Cukup banyak pemegang token |
| `base_token_market_cap` | `$150.000 – $10.000.000` | Bukan micro-cap abal-abal, bukan large-cap |
| `minTokenAgeHours` | `>= 24 jam` | Token sudah berumur minimal 1 hari |

> **Catatan:** `fee_active_tvl_ratio` sengaja dibuat rendah (0.001) karena di timeframe 5m fee yang terakumulasi sangat kecil. Validasi fee yang lebih ketat dilakukan di tahap deployment.

### 1.2 Hasil Query

API mengembalikan hingga 50 pool. Bot mengambil top 10 berdasarkan skor internal (kombinasi volume, organic score, fee/TVL).

---

## FASE 2 — Enrichment & Hard Filter

Untuk setiap kandidat pool, bot mengumpulkan data tambahan secara paralel:

### 2.1 Data yang Dikumpulkan

| Sumber | Data |
|--------|------|
| **OKX** | Risk level, bundle %, sniper %, suspicious wallets %, rugpull flag, wash trading flag, ATH distance |
| **Smart Wallets** | Apakah wallet terkenal (KOL/smart money) sudah ada di pool → confidence boost |
| **Token Narrative** | Cerita/tema di balik token (dari on-chain atau social) |
| **Jupiter Token Info** | Audit: bot_holders_pct, top10_holders_pct, total fees paid, launchpad origin |
| **Active Bin** | Bin harga saat ini di pool (pre-fetch, tidak perlu panggil ulang) |
| **Pool Memory** | Apakah bot pernah masuk pool ini sebelumnya dan bagaimana hasilnya |

### 2.2 Hard Filter Setelah Enrichment

Filter ini **tidak bisa di-bypass oleh LLM**:

| Filter | Kondisi Drop |
|--------|-------------|
| **Launchpad** | Jika `blockedLaunchpads` berisi launchpad token ini |
| **Bot Holders** | `bot_holders_pct > 30%` → drop |
| **Blacklist** | Token atau developer address masuk blacklist |
| **Pool Cooldown** | Pool pernah di-close dengan kerugian baru-baru ini |

---

## FASE 3 — Evaluasi LLM (AI Decision)

Kandidat yang lolos hard filter dikirim ke LLM (saat ini: **minimax/minimax-m2.5**).

### 3.1 Apa yang Diberikan ke LLM

```
- Strategy aktif (bid_ask, SOL-only, single-side)
- Jumlah posisi saat ini & SOL tersedia
- Data lengkap setiap kandidat: metrics, audit, OKX signals, smart wallets, narrative, memory
- Instruksi formula bins_below berdasarkan volatilitas
```

### 3.2 Kriteria Evaluasi LLM

LLM menilai setiap kandidat berdasarkan:
1. **Narrative quality** — Apakah ada cerita spesifik dan kuat di balik token?
2. **Smart wallets present** — Wallet terkenal sudah masuk = confidence boost
3. **Pool metrics** — Volume, fee/TVL, volatilitas, organic score
4. **Risk signals** — OKX: rugpull, wash, bundle, sniper tinggi = penalti
5. **Comparative analysis** — Pilih yang terbaik, bukan asal yang pertama

LLM **bebas menolak semua kandidat** jika tidak ada yang cukup baik (output: `⛔ NO DEPLOY`).

---

## FASE 4 — Deployment Posisi

### 4.1 Strategy: `bid_ask` Single-Side SOL

Bot menggunakan **satu strategi utama**:

```
Strategy    : bid_ask
Deposit     : SOL only (amount_y = 0.5 SOL, amount_x = 0)
Bins Above  : 0 (tidak ada likuiditas di atas harga aktif)
Bins Below  : 35–69 (bergantung volatilitas)
```

**Artinya:** Seluruh likuiditas ditaruh di **bawah harga saat ini**. Bot berposisi sebagai "pembeli" — hanya mendapat fee ketika harga turun dan melewati bin kita.

**Kenapa single-side?** Menghindarkan IL di arah atas (pump). Jika token pump, posisi kita tidak terkena IL karena kita tidak menaruh token di atas.

### 4.2 Formula Bins Below (Berdasarkan Volatilitas)

```
bins_below = round(35 + (volatility / 5) * (69 - 35))
           = round(35 + volatility * 6.8)
clamp ke [35, 69]
```

Contoh:
- Volatility 1.0 → bins_below = 42
- Volatility 3.0 → bins_below = 56
- Volatility 5.0 → bins_below = 69 (maksimal)

Semakin volatil token, semakin lebar range yang dipasang (lebih banyak bins).

### 4.3 Safety Check di Deployment

Sebelum eksekusi on-chain, executor melakukan validasi:

| Check | Kondisi Batal |
|-------|-------------|
| `bins_below < 35` | Terlalu sempit, tolak |
| `bins_above != 0` | Paksa single-side, tolak jika ada atas |
| `amount_x != 0` | Hanya SOL, tolak jika ada token |
| `amount_y <= 0` | Tidak ada SOL, tolak |
| `fee_active_tvl_ratio < 0.05%` | Pool tidak aktif (kecuali ada fallback dari screener) |
| `dry_run = true` | Eksekusi simulasi saja, tidak ada tx on-chain |

---

## FASE 5 — Manajemen Posisi (Setiap 10 Menit)

Setelah posisi terbuka, bot memonitor setiap 10 menit.

### 5.1 Exit Rules (Deterministik — Pasti Dieksekusi)

| Rule | Kondisi | Aksi |
|------|---------|------|
| **Rule 1 — Stop Loss** | PnL ≤ **-50%** | CLOSE |
| **Rule 2 — Take Profit** | PnL ≥ **+5%** | CLOSE |
| **Rule 3 — Pump Far Above** | Active bin > upper bin + 10 bins | CLOSE (token pump keras, posisi kita kosong) |
| **Rule 4 — Out of Range** | Di luar range > **30 menit** | CLOSE |
| **Rule 5 — Low Yield** | Fee/TVL 24h < **7%** setelah 60 menit | CLOSE (pool tidak produktif) |

### 5.2 Trailing Take Profit

Sistem trailing profit untuk mengamankan keuntungan:

```
Trailing aktif saat  : PnL mencapai +3% (trailingTriggerPct)
Trail drop           : Jika PnL turun 1.5% dari peak → CLOSE
```

Contoh:
- PnL naik ke +4.2% → trailing aktif, peak = 4.2%
- PnL turun ke +2.7% (drop 1.5%) → CLOSE dengan profit +2.7%

### 5.3 Evaluasi LLM di Management

Untuk posisi yang tidak terkena exit rule deterministik, LLM juga mengevaluasi:
- Kondisi pasar saat ini vs saat entry
- Apakah masih worth holding atau lebih baik close
- Smart wallets masih ada atau sudah keluar

---

## FASE 6 — Darwin System (Adaptive Learning)

Bot memiliki sistem pembelajaran adaptif bernama **Darwin**:

| Parameter | Nilai |
|-----------|-------|
| `darwinEnabled` | `true` |
| `darwinWindowDays` | 60 hari lookback |
| `darwinRecalcEvery` | Setiap 5 siklus |
| `darwinBoost` | 1.05x (sinyal bagus dapat boost) |
| `darwinDecay` | 0.95x (sinyal buruk dapat penalti) |
| `darwinFloor` | 0.3x (batas minimum weight) |
| `darwinCeiling` | 2.5x (batas maksimum weight) |
| `darwinMinSamples` | 10 samples minimum |

Darwin melacak sinyal mana yang paling prediktif terhadap profit (organic_score, volume, smart_wallets_present, volatility, dll) dan menyesuaikan bobotnya otomatis berdasarkan hasil nyata.

---

## Konfigurasi Aktif (VPS)

```json
{
  "dryRun": true,
  "deployAmountSol": 0.5,
  "maxPositions": 3,
  "strategy": "bid_ask",
  "minBinsBelow": 35,
  "maxBinsBelow": 69,
  "stopLossPct": -50,
  "takeProfitPct": 5,
  "trailingTakeProfit": true,
  "trailingTriggerPct": 3,
  "trailingDropPct": 1.5,
  "outOfRangeBinsToClose": 10,
  "outOfRangeWaitMinutes": 30,
  "minFeePerTvl24h": 7,
  "screeningIntervalMin": 30,
  "managementIntervalMin": 10
}
```

---

## Mengapa Tidak Bisa Di-Backtest Langsung

| Alasan | Penjelasan |
|--------|-----------|
| **Bukan sinyal entry/exit** | LP strategy butuh simulasi fee per-tick, bukan candle close |
| **Fee income = f(volume)** | Bergantung volume yang melewati bin kita — tidak bisa diprediksi dari OHLCV saja |
| **Impermanent Loss kompleks** | Perlu data harga tick-by-tick dan posisi relatif terhadap active bin |
| **LLM non-deterministik** | Setiap run bisa menghasilkan keputusan berbeda |
| **Pool availability berubah** | Pool yang ada hari ini belum tentu ada di data historis |

**Alternatif evaluasi:** Biarkan dry-run berjalan beberapa hari, lihat pool apa yang dipilih, dan ukur hasil hipotetisnya dari data fee pool yang bisa diambil dari Meteora.

---

## Ringkasan Sumber Profit & Risiko

| | Keterangan |
|-|-----------|
| **Sumber profit** | Fee dari transaksi yang melewati bin range kita |
| **Profit terbaik** | Token yang bergerak naik-turun di sekitar harga entry (sideways-volatile) |
| **Risiko terbesar** | Token pump tajam → keluar range atas → posisi idle, tidak dapat fee |
| **Mitigasi** | Single-side deploy (tidak ada IL di atas), Rule 3 close saat pump jauh |
| **Break-even** | Butuh cukup volume agar fee > gas + IL |
