# Screening.js — Bug, Kelemahan, dan Rekomendasi Perbaikan

## Ringkasan Singkat

File `screening.js` berfungsi sebagai modul penyaring pool Meteora/DLMM untuk memilih kandidat pool yang layak dievaluasi agent. Secara umum alurnya sudah bagus: ambil pool dari Pool Discovery API, gabungkan Discord signal, filter risiko token/dev, enrich data OKX, konfirmasi indikator, lalu scoring.

Namun ada beberapa titik rawan yang perlu diperbaiki sebelum dipakai live, terutama:

1. Validasi konfigurasi belum aman.
2. Filter volatility bisa memakai data timeframe yang tidak sesuai.
3. Kandidat dari Discord signal bisa masuk dengan data tidak lengkap.
4. Ranking awal memakai rumus sederhana yang bisa bias.
5. API call eksternal belum punya timeout/retry/concurrency limit.
6. Beberapa filter berpotensi tidak konsisten antara query API dan filter lokal.
7. Logging `filtered_examples` terlalu sedikit untuk debugging live.

---

## Prioritas Perbaikan

| Prioritas | Area | Risiko | Dampak |
|---|---|---:|---|
| P0 | Validasi config `screening` | Tinggi | Bot bisa filter salah, query API rusak, atau kandidat buruk lolos |
| P0 | Volatility timeframe fallback | Tinggi | Pool terlalu volatile/kurang data bisa tetap lolos |
| P0 | Discord signal mode | Tinggi | Pool dari signal bisa bypass kualitas data awal |
| P1 | API timeout/retry | Sedang-Tinggi | Bot bisa lambat/hang saat API eksternal bermasalah |
| P1 | Scoring awal `scoreCandidate` | Sedang | Kandidat terbaik bisa kalah ranking oleh metrik bias |
| P1 | Observability/debug output | Sedang | Sulit tahu kenapa pool ditolak/diterima |
| P2 | Refactor modular | Sedang | File makin sulit dirawat dan diuji |

---

## Bug / Risiko Logika yang Ditemukan

### 1. Config `screening` tidak divalidasi sebelum dipakai

Di `discoverPools()`, banyak nilai config langsung dipakai untuk membentuk query:

```js
`base_token_market_cap>=${s.minMcap}`,
`base_token_market_cap<=${s.maxMcap}`,
`base_token_holders>=${s.minHolders}`,
`volume>=${s.minVolume}`,
`tvl>=${s.minTvl}`,
```

Masalahnya, jika salah satu nilai `undefined`, `null`, atau string kosong, query API bisa menjadi seperti:

```txt
base_token_market_cap>=undefined
base_token_market_cap<=null
```

Dampaknya:
- API bisa mengembalikan hasil aneh/kosong.
- Filter lokal bisa tidak sama dengan filter API.
- `maxMcap = null` bisa menyebabkan logika perbandingan salah.

Contoh rawan:

```js
if (mcap > s.maxMcap) return `mcap ${mcap} above maxMcap ${s.maxMcap}`;
```

Jika `s.maxMcap` adalah `null`, JavaScript bisa menganggap `null` sebagai `0` pada perbandingan numerik. Akibatnya token dengan market cap normal bisa dianggap melewati batas.

#### Perbaikan

Buat validator config sebelum `discoverPools()` berjalan:

```js
function requireNumber(name, value, { min = 0 } = {}) {
  const n = Number(value);
  if (!Number.isFinite(n) || n < min) {
    throw new Error(`Invalid screening config: ${name}=${value}`);
  }
  return n;
}

function normalizeScreeningConfig(raw) {
  return {
    ...raw,
    minMcap: requireNumber("minMcap", raw.minMcap),
    maxMcap: raw.maxMcap == null ? Infinity : requireNumber("maxMcap", raw.maxMcap),
    minHolders: requireNumber("minHolders", raw.minHolders),
    minVolume: requireNumber("minVolume", raw.minVolume),
    minTvl: requireNumber("minTvl", raw.minTvl),
    maxTvl: raw.maxTvl == null ? null : requireNumber("maxTvl", raw.maxTvl),
    minBinStep: requireNumber("minBinStep", raw.minBinStep),
    maxBinStep: requireNumber("maxBinStep", raw.maxBinStep),
    minFeeActiveTvlRatio: requireNumber("minFeeActiveTvlRatio", raw.minFeeActiveTvlRatio),
    minOrganic: requireNumber("minOrganic", raw.minOrganic),
    minQuoteOrganic: requireNumber("minQuoteOrganic", raw.minQuoteOrganic),
  };
}
```

Lalu di awal:

```js
const s = normalizeScreeningConfig(config.screening);
```

---

### 2. Bug volatility timeframe: fallback bisa gagal diam-diam

Kode mencoba memakai minimal timeframe `30m` untuk volatility:

```js
const MIN_VOLATILITY_TIMEFRAME = "30m";
```

Jika source timeframe misalnya `5m`, fungsi `applyVolatilityTimeframe()` fetch ulang detail pool dengan timeframe `30m`.

Masalahnya:
- Jika fetch detail gagal, `pool.volatility` lama dari timeframe `5m` tetap dipakai.
- `pool.volatility_timeframe` tidak selalu diset jika detail gagal.
- Filter berikutnya hanya cek angka volatility valid, bukan timeframe valid.

```js
if (!isUsableVolatility(volatility)) {
  return `volatility ${volatility ?? "unknown"} is unusable`;
}
```

Dampaknya:
- Pool bisa lolos memakai volatility 5m, padahal sistem ingin minimal 30m.
- Risiko range terlalu sempit/lebar karena volatility data terlalu pendek.

#### Perbaikan

Jika target volatility timeframe berbeda dan data target gagal didapat, pool sebaiknya ditandai invalid:

```js
for (const pool of rawPools) {
  if (!pool?.pool_address) continue;

  if (volatilityByPool.has(pool.pool_address)) {
    pool.volatility = volatilityByPool.get(pool.pool_address);
    pool.volatility_timeframe = volatilityTimeframe;
  } else {
    pool.volatility = null;
    pool.volatility_timeframe = volatilityTimeframe;
    pool.volatility_missing = true;
  }
}
```

Lalu filter:

```js
if (pool?.volatility_missing) {
  return `volatility unavailable for required timeframe ${pool.volatility_timeframe}`;
}
```

---

### 3. `fetchPoolDiscoveryDetail()` tidak mengirim `category`

`fetchPoolDiscoveryPage()` mengirim:

```js
&category=${category}
```

Tapi `fetchPoolDiscoveryDetail()` tidak mengirim `category`.

Dampaknya:
- Data detail pool bisa tidak konsisten dengan discovery utama.
- Volatility/timeframe detail bisa berasal dari kategori default API, bukan kategori screening.

#### Perbaikan

Tambahkan parameter `category`:

```js
async function fetchPoolDiscoveryDetail({ poolAddress, timeframe, category = config.screening.category }) {
  const url = `${POOL_DISCOVERY_BASE}/pools?` +
    `page_size=1` +
    `&filter_by=${encodeURIComponent(`pool_address=${poolAddress}`)}` +
    `&timeframe=${timeframe}` +
    `&category=${category}`;
}
```

---

### 4. Discord signal mode bisa memasukkan pool dengan data kurang lengkap

Saat `discordSignalMode === "only"`:

```js
rawPools = signalPools;
```

Masalah:
- `signalPools` memakai `candidate.discovery_pool`.
- Belum tentu field-nya lengkap seperti hasil Pool Discovery API normal.
- Kalau data token/quote/organic/holders/tvl tidak lengkap, pool bisa banyak ditolak, atau lebih parah: lolos dengan field yang salah jika struktur berubah.

#### Perbaikan

Untuk setiap `signalPool`, fetch ulang detail dari Pool Discovery API berdasarkan `pool_address`, lalu baru merge metadata Discord:

```js
const detailedSignalPools = await Promise.allSettled(
  signalPools.map(async (signalPool) => {
    const detail = await fetchPoolDiscoveryDetail({
      poolAddress: signalPool.pool_address,
      timeframe: s.timeframe,
      category: s.category,
    });
    return {
      ...detail,
      discord_signal: true,
      discord_signal_count: signalPool.discord_signal_count,
      discord_signal_seen_count: signalPool.discord_signal_seen_count,
      discord_signal_first_seen_at: signalPool.discord_signal_first_seen_at,
      discord_signal_last_seen_at: signalPool.discord_signal_last_seen_at,
    };
  })
);
```

---

### 5. Allowed launchpad filter tidak konsisten

Di query API, jika `allowedLaunchpads` ada, filter ini diterapkan global:

```js
base_token_launchpad=[...]
```

Tapi di filter lokal, pengecekan allow-list hanya dilakukan untuk pool yang punya `discord_signal`.

Dampaknya:
- Pool non-Discord mengandalkan API filter.
- Pool Discord yang digabung manual baru dicek lokal.
- Jika API filter berubah atau data launchpad kosong, hasil bisa tidak konsisten.

#### Perbaikan

Jadikan aturan eksplisit:

```js
if (
  Array.isArray(s.allowedLaunchpads) &&
  s.allowedLaunchpads.length > 0
) {
  if (!launchpad) return "launchpad unknown while allow-list is enabled";
  if (!includesCaseInsensitive(s.allowedLaunchpads, launchpad)) {
    return `launchpad ${launchpad} not in allow-list`;
  }
}
```

---

### 6. `scoreCandidate()` terlalu sederhana dan bisa bias

Saat shortlist/ranking awal, rumusnya:

```js
return feeTvl * 1000 + organic * 10 + volume / 100 + holders / 100;
```

Masalah:
- Volume besar bisa mendominasi.
- Holder besar bisa memberi skor tinggi walau pool tidak efisien.
- Tidak mempertimbangkan volatility, active liquidity, risk flags.

#### Perbaikan

Gunakan skor lebih defensif dengan log-scale untuk volume dan holder:

```js
function scoreCandidate(pool) {
  const feeTvl   = Number(pool.fee_active_tvl_ratio || 0);
  const organic  = Number(pool.organic_score || pool.base?.organic || 0);
  const volume   = Math.log10(Number(pool.volume_window || 0) + 1);
  const holders  = Math.log10(Number(pool.holders || 0) + 1);
  const activePct = Number(pool.active_pct || 0);
  const volatility = Number(pool.volatility || 0);

  let score = 0;
  score += feeTvl * 1000;
  score += organic * 3;
  score += volume * 20;
  score += holders * 10;
  score += activePct * 0.5;

  if (!Number.isFinite(volatility) || volatility <= 0) score -= 100;
  if (volatility > 20) score -= 50;

  return score;
}
```

---

### 7. API eksternal belum punya timeout/retry

Ada banyak call ke Pool Discovery, Meteora, Jupiter, OKX, Agent Meridian tanpa timeout.

#### Perbaikan

```js
async function fetchJson(url, { timeoutMs = 8000, retries = 2, headers } = {}) {
  let lastError;
  for (let attempt = 0; attempt <= retries; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetch(url, { headers, signal: controller.signal });
      clearTimeout(timer);
      if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
      return await res.json();
    } catch (error) {
      clearTimeout(timer);
      lastError = error;
      if (attempt === retries) break;
      await new Promise((r) => setTimeout(r, 500 * (attempt + 1)));
    }
  }
  throw lastError;
}
```

---

### 8. `Promise.allSettled()` batch besar tanpa concurrency limit

Batch fetch volatility bisa meledak tanpa batas.

#### Perbaikan — concurrency limit 5

```js
async function mapLimit(items, limit, fn) {
  const results = [];
  const executing = new Set();
  for (const item of items) {
    const p = Promise.resolve().then(() => fn(item));
    results.push(p);
    executing.add(p);
    p.finally(() => executing.delete(p));
    if (executing.size >= limit) await Promise.race(executing);
  }
  return Promise.allSettled(results);
}
```

---

### 9. `filtered_examples` hanya 3 item

Terlalu sedikit untuk debugging live.

#### Perbaikan

```js
const debugLimit = Number(config.screening.filteredExamplesLimit ?? 20);

return {
  candidates: eligible,
  total_screened: pools.length,
  filtered_examples: filteredOut.slice(0, debugLimit),
  filter_summary: filteredOut.reduce((acc, item) => {
    acc[item.reason] = (acc[item.reason] || 0) + 1;
    return acc;
  }, {}),
};
```

---

### 10. Risk filter belum lengkap sebelum scoring

Field `is_rugpull`, `risk_level`, `sniper_pct`, `suspicious_pct`, `dev_sold_all` hanya ditempel ke candidate, belum jadi hard filter.

#### Perbaikan

```js
if (p.is_rugpull)  return "flagged as rugpull";
if (p.risk_level === "high") return "risk_level high";
if (Number(p.bundle_pct)     > (config.screening.maxBundlePct     ?? 30)) return `bundle_pct ${p.bundle_pct} > limit`;
if (Number(p.sniper_pct)     > (config.screening.maxSniperPct     ?? 30)) return `sniper_pct ${p.sniper_pct} > limit`;
if (Number(p.suspicious_pct) > (config.screening.maxSuspiciousPct ?? 30)) return `suspicious_pct ${p.suspicious_pct} > limit`;
if (p.dev_sold_all === true && config.screening.blockDevSoldAll)           return "dev sold all tokens";
```

---

### 11. Error handling indicator terlalu permisif

Saat indikator error, pool tetap lolos (`confirmed: true, skipped: true`). Untuk live ini berbahaya.

#### Perbaikan

```js
const failOpen = config.indicators.failOpenOnError ?? false; // false untuk live
// ...
confirmed: failOpen,
skipped: true,
reason: `Indicator confirmation unavailable: ${error.message}`,
```

---

## Rekomendasi Patch Bertahap

### Tahap 1 — Wajib sebelum live (P0)
1. Validasi config screening (`normalizeScreeningConfig`)
2. Perbaiki volatility fallback (`volatility_missing` flag)
3. Tambahkan timeout fetch (8 detik, retry 2x)
4. Hard filter `is_rugpull`, `risk_level`, `sniper_pct`, `suspicious_pct`
5. Indicator error tidak otomatis confirmed saat live

### Tahap 2 — Debugging & monitoring (P1)
1. Tambahkan funnel count (api_total → after_blacklist → after_eligibility)
2. `filter_summary` — summary alasan reject per kategori
3. Naikkan `filtered_examples` ke 20 (configurable)
4. `scoreCandidate()` pakai log-scale
5. `fetchPoolDiscoveryDetail()` kirim `category`

### Tahap 3 — Refactor (P2)
1. Pisahkan module: discovery, enrichment, filters, scoring
2. Tambahkan unit test untuk fungsi filter kritis
3. Concurrency limit untuk batch fetch
4. Config `liveRiskMode: strict | balanced | permissive`

---

## Checklist Kandidat Pool Sebelum Deploy Live

```
[ ] Config screening valid (tidak ada undefined/null)
[ ] Pool type DLMM
[ ] TVL dalam batas (minTvl–maxTvl)
[ ] Volume >= minVolume
[ ] Holder >= minHolders
[ ] Market cap dalam batas (minMcap–maxMcap)
[ ] Fee/active TVL >= minFeeActiveTvlRatio
[ ] Volatility tersedia pada timeframe minimal 30m
[ ] Organic score base >= minOrganic
[ ] Organic score quote >= minQuoteOrganic
[ ] Tidak critical warning
[ ] Tidak high supply concentration
[ ] Tidak high single ownership
[ ] Token/dev tidak blacklist
[ ] Pool/base mint tidak dalam cooldown
[ ] Tidak sedang punya posisi di pool/token yang sama
[ ] OKX: tidak flag wash trading
[ ] OKX: is_rugpull = false
[ ] OKX: risk_level != high
[ ] Bundle/sniper/suspicious pct di bawah limit
[ ] Dev tidak sold all
[ ] Tidak terlalu dekat ATH
[ ] Indicator confirmation lolos
[ ] Pool scorer grade minimal B
```

---

## Kesimpulan

`screening.js` sudah punya fondasi bagus, tapi untuk live trading perlu lebih defensif. Masalah terbesar bukan di syntax, melainkan di **validasi data** dan **fallback ketika API eksternal gagal**.

Perbaikan paling penting:
1. Jangan biarkan config `undefined/null` masuk ke query/filter
2. Jangan biarkan volatility timeframe pendek dipakai diam-diam
3. Jangan otomatis meloloskan kandidat saat modul risk/indicator gagal
4. Tambahkan timeout, retry, dan concurrency limit
5. Buat output funnel agar alasan pool lolos/ditolak bisa diaudit
