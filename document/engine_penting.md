# Engine Penting — Meridian Bot

Dokumen ini menjelaskan engine-engine kritis yang menentukan performa bot, cara memeriksanya, dan indikator bagus/buruk sebelum memutuskan go-live.

---

## Ringkasan Engine

| Engine | File | Fungsi |
|--------|------|--------|
| Filter Pool | `tools/screening.js` | Discovery & filter kandidat pool |
| Ranking Pool | `strategy/pool-scorer.js` | Scoring & grading A–F |
| Darwin Weighting | `signal-weights.js` | Boost/decay bobot signal dari riwayat trade |
| Exit Strategy | `index.js` | Stop-loss, take-profit, OOR detection |
| Learning Engine | `lessons.js` | Belajar dari closed trade, evolve threshold |
| Eksekusi On-chain | `tools/dlmm.js` | Deploy, close, claim fee via Meteora SDK |
| Otak LLM | `agent.js` | ReAct loop — LLM baca hasil screening lalu putuskan |

---

## Engine 1 — Filter Pool (`tools/screening.js`)

**Fungsi:** Mengambil kandidat pool dari Meteora API lalu menyaring secara berlapis.

### Tahapan Filter (berurutan)

| Tahap | Filter | Config Key | Default |
|-------|--------|-----------|---------|
| 1 | Basic: TVL, Volume, BinStep | `minTvl`, `maxTvl`, `minVolume` | 10k–150k, 500 |
| 2 | Organic score | `minOrganic` | 60% |
| 3 | Token age | `minTokenAgeHours` | 24 jam |
| 4 | Bot holders | `maxBotHoldersPct` | 30% |
| 5 | Top 10 holders | `maxTop10Pct` | 60% |
| 6 | Bundler | `maxBundlePct` | 30% |
| 7 | Fee/aTVL ratio | `minFeeActiveTvlRatio` | 0.05 |
| 8 | PVP rivals | `avoidPvpSymbols` | true |
| 9 | Launchpad blacklist | `blockedLaunchpads` | [] |
| 10 | Cooldown (repeat deploy) | `repeatDeployCooldownHours` | 12 jam |
| 11 | Duplicate pool/token | — | otomatis |

### Cara Monitor
```bash
pm2 logs meridian | grep -E "SCREENING|dropped|filter|candidate"
```

### Indikator
| Kondisi | Status |
|---------|--------|
| Ada kandidat lolos tiap siklus | BAGUS |
| Semua di-drop karena `bots > 30%` | Normal — pool jelek |
| Selalu 0 kandidat > 3 hari | PERLU TUNING filter |
| Kandidat lolos tapi selalu grade D/F | PERLU TUNING threshold |

---

## Engine 2 — Ranking Pool (`strategy/pool-scorer.js`)

**Fungsi:** Memberi skor numerik dan grade A–F ke pool yang lolos filter.

### Signal yang Diukur

| Signal | Bobot | Keterangan |
|--------|-------|-----------|
| `fee_tvl_ratio` | Tinggi | Fee dihasilkan vs TVL — indikator aktifitas |
| `organic_score` | Tinggi | % volume organik (bukan bot) |
| `in_range_pct` | Sedang | Seberapa sering harga dalam range LP |
| `volume` | Sedang | Volume trading 24 jam |
| `bin_step` | Sedang | Kesesuaian bin step dengan volatilitas |
| `holders` | Rendah | Jumlah holder token |

### Grade

| Grade | Score | Artinya |
|-------|-------|---------|
| A | 80–100 | Sangat layak deploy |
| B | 65–79 | Layak deploy |
| C | 50–64 | Cukup, perlu perhatian |
| D | 35–49 | Kurang layak |
| F | 0–34 | Jangan deploy |

### Cara Monitor
```bash
pm2 logs meridian | grep -E "score|grade|pool-scorer"
```

### Indikator
| Kondisi | Status |
|---------|--------|
| Mayoritas deploy grade A/B | BAGUS |
| Mayoritas deploy grade C/D | PERLU evaluasi scorer |
| Pool grade A tapi loss konsisten | Perlu review bobot signal |

---

## Engine 3 — Darwin Weighting (`signal-weights.js`)

**Fungsi:** Secara otomatis boost bobot signal yang terbukti profitable dan decay signal yang sering menghasilkan loss.

### Cara Kerja
- Setiap N closed trades (default: 5), Darwin recalculate semua bobot
- Signal pada posisi profit → weight × `boostFactor` (1.05)
- Signal pada posisi loss → weight × `decayFactor` (0.95)
- Weight di-clamp antara `weightFloor` (0.3) dan `weightCeiling` (2.5)

### Config Key
```json
"darwinEnabled": true,
"darwinWindowDays": 60,
"darwinRecalcEvery": 5,
"darwinBoost": 1.05,
"darwinDecay": 0.95,
"darwinFloor": 0.3,
"darwinCeiling": 2.5,
"darwinMinSamples": 10
```

### Cara Monitor
```bash
pm2 logs meridian | grep -E "darwin|Darwin|weight|recalc"
cat /opt/bot/meridian/signal-weights.json
```

### Indikator
| Kondisi | Status |
|---------|--------|
| Weight berubah setelah 5 close | BAGUS — sistem belajar |
| Semua weight masih 1.0 setelah 20+ trade | MASALAH — darwin tidak aktif |
| 1 signal weight mendekati 2.5 | Signal itu sangat reliable |
| 1 signal weight mendekati 0.3 | Signal itu tidak reliable |

> **Catatan:** Darwin butuh minimal 10 closed trades (`darwinMinSamples`) sebelum mulai bekerja efektif.

---

## Engine 4 — Exit Strategy (`index.js`)

**Fungsi:** Menentukan kapan posisi harus ditutup berdasarkan aturan deterministik (tanpa LLM).

### Aturan Exit (berurutan)

| Kondisi | Tindakan | Config Key | Default |
|---------|----------|-----------|---------|
| PnL < -50% | Close (stop-loss) | `stopLossPct` | -50% |
| PnL > 5% | Aktifkan trailing TP | `takeProfitPct` | 5% |
| Trailing: peak turun > 1.5% | Close (trailing TP) | `trailingDropPct` | 1.5% |
| OOR > 30 menit | Close | `outOfRangeWaitMinutes` | 30 |
| Fee/TVL 24h < 7% setelah 60 menit | Close (yield rendah) | `minFeePerTvl24h` | 7% |
| Pool migrated/closed | Close otomatis | — | — |

### Cara Monitor
```bash
pm2 logs meridian | grep -E "CLOSE|stop.loss|take.profit|OOR|out.of.range|yield"
```

### Indikator
| Kondisi | Status |
|---------|--------|
| Stop-loss terpicu, posisi ditutup | BAGUS — proteksi bekerja |
| Trailing TP terpicu, profit terkunci | BAGUS |
| Posisi OOR > 1 jam tidak ditutup | MASALAH — cek outOfRangeWaitMinutes |
| Banyak close karena yield rendah | Screener perlu lebih selektif |

---

## Engine 5 — Learning Engine (`lessons.js`)

**Fungsi:** Merekam performa setiap closed position dan secara otomatis menyesuaikan threshold screening.

### Cara Kerja
1. Setiap `close_position` → `recordPerformance()` dipanggil
2. Lessons di-inject ke system prompt agent di siklus berikutnya
3. `evolveThresholds()` menyesuaikan `minOrganic`, `minHolders`, `minFeeActiveTvlRatio`, dll

### Cara Monitor
```bash
cat /opt/bot/meridian/lessons.json
pm2 logs meridian | grep -E "lesson|evolve|threshold|learn"
```

### Indikator
| Kondisi | Status |
|---------|--------|
| `lessons.json` makin banyak isi | BAGUS — bot belajar |
| Threshold screening berubah setelah beberapa close | BAGUS |
| `lessons.json` kosong setelah 10+ close | MASALAH |

> **Known issue:** `evolveThresholds()` saat ini mengupdate key `maxVolatility` dan `minFeeTvlRatio` yang tidak ada di config — efeknya no-op untuk kedua key tersebut. Key yang benar-benar berubah: `minOrganic`, `minHolders`, `minFeeActiveTvlRatio`.

---

## Metrik Utama — Target Sebelum Go-Live

| Metrik | Target Go-Live | Waspada |
|--------|---------------|---------|
| Win rate | **> 55%** | < 45% |
| Avg PnL per trade | **> +1%** | Negatif konsisten |
| Avg hold time | **1–6 jam** | > 12 jam (stuck OOR) |
| Pool grade deployed | **A/B mayoritas** | C/D/F mayoritas |
| Screener candidates | **> 1 per siklus** | Selalu 0 |
| Darwin weights aktif | **Setelah 10 close** | Stuck semua 1.0 |
| Stop-loss terpicu wajar | **< 20% dari trade** | > 40% |

> **Rekomendasi:** Tunggu minimal **20–30 closed trades** dari dry-run (sekitar 3–5 hari) sebelum memutuskan go-live.

---

## Command Monitoring Harian

```bash
# Status semua service
pm2 status

# Log realtime
pm2 logs meridian

# Filter khusus screening
pm2 logs meridian --lines 200 | grep -E "SCREENING|score|grade|dropped"

# Filter khusus trade
pm2 logs meridian --lines 200 | grep -E "DEPLOY|CLOSE|pnl|profit|loss"

# Filter khusus exit triggers
pm2 logs meridian --lines 200 | grep -E "stop.loss|take.profit|OOR|yield"

# Lihat trade history
node -e "const d=require('./data/pnl_log.json'); const c=d.trades.filter(t=>t.status==='closed'); console.log('Closed:', c.length, '| Wins:', c.filter(t=>t.pnl_pct>0).length, '| WinRate:', (c.filter(t=>t.pnl_pct>0).length/c.length*100).toFixed(1)+'%', '| AvgPnL:', (c.reduce((s,t)=>s+t.pnl_pct,0)/c.length).toFixed(2)+'%')"

# Lihat Darwin weights
cat signal-weights.json | node -e "const d=JSON.parse(require('fs').readFileSync('/dev/stdin','utf8')); console.log(JSON.stringify(d.weights, null, 2))"
```

---

## Alur Keputusan Go-Live

```
Dry-run 20-30 trade
        │
        ▼
  Win rate > 55% ?
   ├── YA → lanjut
   └── TIDAK → review engine screening + scorer
        │
        ▼
  Avg PnL > +1% ?
   ├── YA → lanjut
   └── TIDAK → review exit strategy (TP/SL terlalu ketat?)
        │
        ▼
  Darwin weights berubah ?
   ├── YA → lanjut
   └── TIDAK → cek darwinEnabled + darwinMinSamples
        │
        ▼
  Pool grade deploy A/B mayoritas ?
   ├── YA → SIAP GO-LIVE
   └── TIDAK → tuning pool-scorer weights
```
