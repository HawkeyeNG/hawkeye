# Scaling Hawkeye to 1,000,000 users (January 2027)

*Infrastructure sizing for a million registered users through the 16 Jan / 6 Feb
2027 election windows — cloud primary + full self-owned failover. 2026-07-11.*

## 1. Load model (what 1M users actually means)

| Dimension | Estimate | Basis |
|---|---|---|
| Polling units | 176,000 | INEC register |
| Election-day signed reports | ~500,000 | 2–4 observers at a fraction of units × contests |
| Report photos | ~1M images ≈ 300–450 GB | 2 photos/report, client-compressed ~300–450 KB |
| Incident media (incl. video) | ~50k files ≈ 250 GB | 720p re-encode server-side |
| Write peak (18:00–22:00 flood) | **40–100 submission POSTs/s** | ~1 MB multipart each; ECDSA verify + dedupe hash inline; OCR/vision sampled + queued, never inline |
| Read peak | 2,000–5,000 req/s at the edge | 1M users × ~20 hits/day, bursty |
| Origin read load after Cloudflare cache | ~100–300 req/s | results JSON cacheable 10–30 s; static shell fully edge-cached |
| Storage per election cycle | **1–2 TB** | photos + video + DB + ledger archives |

Key insight: **Cloudflare absorbs the read side; the real problem is the write
flood + media storage + a single-writer database.**

## 2. Is GO54 sufficient? No.

Shared Passenger + SQLite (one writer) + app-server disk fails at roughly 1% of
this load: the DB serializes the write flood, the disk fills in the first hours,
and there is no horizontal scale. GO54 remains fine for the beta and as a cheap
static fallback — not for January.

## 3. Cloud primary (election-grade)

- **Edge**: Cloudflare (already in place) — WAF, rate limits, cache, Tunnel.
- **App tier**: 2–3 × 8 vCPU Node containers (or Hetzner/OVH dedicated boxes,
  ~€50/mo each) behind CF; stateless, so N+1 scaling is a dial.
- **Database**: managed **Postgres** (8 vCPU / 32 GB + read replica). The ledger,
  Merkle anchoring and docket are storage-agnostic — port unchanged.
- **Media**: **Cloudflare R2** (S3-compatible, zero egress behind CF). 2 TB ≈
  $30/mo. Images never touch app-server disk again.
- **Queue + workers**: Redis + 2–4 workers for sharp re-encode, OCR sampling,
  vision sampling, notifications.
- **Cost**: election months **$500–1,500/mo** managed (or $250–500/mo on
  dedicated Hetzner); off-peak **<$300/mo**. Migration is config + a Postgres
  port, not a rewrite.

## 4. Self-owned failover (attack / deplatform scenario)

Goal: if every cloud account dies, Hawkeye still serves the country from
hardware we own, behind Cloudflare Tunnel on Starlink.

**2× NVIDIA DGX Spark** (128 GB unified, 4 TB NVMe, ~$4k each):

| Box | Role |
|---|---|
| Spark A | Full stack: Node app + Postgres + nightly-synced 2 TB media mirror (fits in 4 TB NVMe) |
| Spark B | AI inference (Qwen2.5-VL vision + text model via Ollama) **and** warm standby of Spark A (ConnectX link) |

- With CF cache in front, origin failover load ≈ the write flood (~100 req/s) —
  within one Spark's capacity when media reads come from the local mirror/R2.
- At 1M-user scale the *assistant* stays on hosted free tiers for burst; on-prem
  AI covers sampled EC8A vision + reduced-rate assistant indefinitely.
- **Mac Studio alternative** (M3/M4 Ultra, 256 GB, ~$5.6k): ~3× the memory
  bandwidth → faster LLM inference per box, and a legitimate substitute for
  Spark B. Not preferred for Spark A's role: macOS lacks the Linux server
  posture (Docker-in-VM, no systemd), while DGX OS is Ubuntu — full stack
  parity. Verdict: Sparks first; a Mac Studio is an acceptable inference add-on.
- 3rd Spark = optional cold spare / regional mirror when funded.

## 5. Power (upgraded from 1.5 kVA)

Continuous load: 2× Spark ≈ 480 W + Starlink ~75 W + router/switch ~50 W ≈
**600 W (800 W peak)** → 14.4 kWh/day.

| Component | Size | Why |
|---|---|---|
| Inverter | **3.5 kVA** (pure sine) | comfortable loading headroom (~800 W peak load); 1.5 kVA was sized for one Spark |
| Panels | **~3.5 kWp** | Nigeria ≈ 4.5–5 peak sun hours → ~15–16 kWh/day |
| Battery | **10 kWh LiFePO₄** | ≥14 h overnight/outage autonomy |
| Nigeria cost | **$4,000–6,000** installed | replaces UPS entirely |

## 6. Budget deltas (decks updated accordingly)

- On-prem line: ~$11k → **~$16,000–19,000** one-time
  (2× Spark $8k · 3.5 kVA/3.5 kWp/10 kWh solar $5k · Starlink kit + 12 mo service
  $1.2k · networking/spares $1k · contingency).
- New opex line: **cloud $500–1,500/mo during election windows**, <$300/mo off-peak.
- Everything ships against GO54 today and re-points by base-URL swap; the
  trust core (ledger, Rekor, Merkle proofs, docket) is unchanged at any scale.
