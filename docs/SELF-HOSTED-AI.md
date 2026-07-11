# Hawkeye — Self-Hosted AI (Ollama) + On-Prem Infrastructure

*How to run Hawkeye's text-AI locally (laptop now, physical server later) at $0
per-token, and where on-prem infrastructure fits as backup/primary hosting. The
EC8A **vision** check stays on a hosted multimodal model (Gemini) — small local
models can't read result sheets.*

## Current live wiring (2026-07-09)

- **Text AI is self-hosted TODAY**: the production assistant runs on a laptop —
  Ollama serving **qwen2.5:3b**, exposed through an **ngrok static domain**
  (`... --host-header=localhost:11434 --url=<your-static>.ngrok-free.dev` — the
  host-header rewrite is required or Ollama 403s; the `--url` flag pins the URL so
  it survives restarts). Server env: `ASSISTANT_API_BASE=<tunnel>/v1`,
  `ASSISTANT_API_KEY=ollama`, `ASSISTANT_MODEL=qwen2.5:3b`.
- **The laptop + tunnel must be online** for the local model; when either is down
  the chain falls back automatically per question: **Groq → Mistral → OpenRouter**
  (keys live on the server). No downtime, just hosted free-tier answers.
- **Gemini is dedicated to EC8A vision** via `VISION_API_*` — local 3B models
  can't read result sheets.
- **This is exactly why the DGX Spark matters**: the laptop setup proves the
  architecture but is fragile (must stay awake, consumer tunnel, 3B-class brain).
  The Spark replaces it with a 24/7 appliance running a **70B text model + a
  Qwen2.5-VL vision model** — removing the last hosted dependency (Gemini) and the
  free-tier data-sharing caveat entirely. Until then, prefer a **named Cloudflare
  Tunnel** over ngrok for a permanently stable URL on our own domain
  (e.g. `ai.hawkeye.com.ng`).

## What can run locally

| Task | Local model works? | Notes |
|---|---|---|
| Results assistant (Q&A) | ⚠ marginal at 3B | needs light tool-use; Qwen2.5-3B is the best small pick, Llama-3.2-3B ok |
| Translation (Hausa/Yoruba/Igbo/Pidgin) | ✅ | small models are fine, no tools |
| Incident triage (kind/urgency/spam) | ✅ | short classify prompt, no tools |
| EC8A vision (read sheet + forgery) | ❌ tiny models · ✅ on a GPU server | needs a 7B+ vision-language model — see below |

Recommended small **text** models: **Qwen2.5 3B** (best instruction-following at
this size) or **Llama 3.2 3B**; **Llama 3.2 1B** only for translation/triage.

### EC8A vision on a physical server (unlocks full self-hosting)

Small text models (and Phi-4 14B, which is **text-only**) can't read result sheets.
A GPU server can run an open **vision-language model (VLM)** that does:

| VLM | VRAM | Notes |
|---|---|---|
| **Qwen2.5-VL 7B** | ~16 GB | best open pick for documents/handwritten tables; RTX 4060 Ti/4070 16 GB |
| **Qwen2.5-VL 32B** | ~24–48 GB | stronger; RTX 3090/4090 24 GB (quantized) or 2×24 GB |
| InternVL2.5-8B / MiniCPM-V 2.6 8B / Llama-3.2-Vision 11B | ~16–24 GB | solid alternatives |
| Phi-4-multimodal 5.6B | ~8–12 GB | small, does vision, weaker on dense handwriting |

Serve it OpenAI-compatibly (Ollama or vLLM) and point Hawkeye's vision at it — no
code change, just env in the server `.env`:
```
VISION_API_BASE=https://<your-vlm-host>/v1
VISION_API_KEY=ollama            # any non-empty value for a local server
VISION_MODEL=qwen2.5-vl:7b
```
Vision falls back to Gemini automatically if the box is unavailable. Result:
**both text AI and EC8A vision run self-hosted at $0/token with no free-tier
data-sharing** — pair a text brain (Qwen2.5/Phi-4) with Qwen2.5-VL for the eyes.

## Laptop setup (start here)

1. **Install Ollama** — https://ollama.com/download (macOS/Windows/Linux).
2. **Pull a model:**
   ```
   ollama pull qwen2.5:3b        # assistant + translation + triage
   ollama pull llama3.2:1b       # optional, lighter, translation/triage only
   ```
3. **Run the API** (Ollama serves an OpenAI-compatible endpoint on :11434):
   ```
   ollama serve                  # or it runs as a service after install
   curl http://localhost:11434/v1/models   # sanity check
   ```
4. **Expose it to the Hawkeye backend.** The backend runs on GO54, so the laptop
   must be reachable. Use a **Cloudflare Tunnel** (free, no open ports):
   ```
   cloudflared tunnel --url http://localhost:11434
   ```
   It prints a public `https://<random>.trycloudflare.com` URL (for a stable URL,
   create a named tunnel on your Cloudflare account).
5. **Point Hawkeye at it** — in the server `backend/.env`:
   ```
   ASSISTANT_API_BASE=https://<your-tunnel>/v1
   ASSISTANT_API_KEY=ollama            # any non-empty value; Ollama ignores it
   ASSISTANT_MODEL=qwen2.5:3b
   ```
   Re-upload `tmp/restart.txt`. The provider chain now calls your box first and
   still falls back to Gemini/Groq/etc. if the laptop is offline.

The laptop must stay awake and connected while it serves. That's fine for dev and
low traffic; for 24/7 public use, move to a physical server.

## Intended server: NVIDIA DGX Spark + Starlink (single-appliance)

The intended production/backup box is the **NVIDIA DGX Spark** — a self-contained
AI appliance that hosts the *entire* Hawkeye stack (Node + DB) **and** the local
models on one unit; "just add internet."

- **GB10 Grace-Blackwell**, **128 GB unified memory**, ~1 PFLOP FP4, runs NVIDIA
  DGX OS (Ubuntu / ARM64). ~**$3,000–4,000** each.
- The 128 GB holds a **large text model (70B-class) + a Qwen2.5-VL vision model +
  the app** at once — full text **and** EC8A vision self-hosted, $0/token.
- **2 units:** link via ConnectX for ~200–405B models and/or run one as a hot
  **failover** (redundancy + bigger models).
- **Connectivity: Starlink** — kit ~$350–600 one-time; service ~$50–150/mo
  (Priority/Business tier for uptime; Nigeria pricing varies). Starlink is CGNAT,
  so expose via **Cloudflare Tunnel** (free, no open ports/static IP).
- **Power: 3 kVA solar system** (~$4,000–6,000 installed in Nigeria): 3 kVA
  pure-sine inverter + **~3.5 kWp panels** + **10 kWh LiFePO₄** battery. The
  two-Spark + Starlink + networking load is ~600 W continuous (≈14.4 kWh/day);
  3.5 kWp generates ~15–16 kWh/day at Nigerian sun hours and the battery gives
  ≥14 h autonomy — true 24/7 off-grid, replaces the UPS entirely. (A 1.5 kVA
  system only carries ONE Spark; sized up for the two-box failover cluster.)
- Caveats: ARM64 (our native deps build fine); desktop-class memory bandwidth, so
  **sample** vision at election-day peak rather than scanning every sheet live.

Cheaper interim tiers if DGX Spark isn't yet in budget:

| Tier | Spec | Runs | Approx. cost |
|---|---|---|---|
| Mini-PC | 32 GB RAM | app + DB + 3B text model on CPU | $350–550 |
| GPU box | RTX 4060/4070 16 GB | 7–8B text + Qwen2.5-VL 7B | $1,500–2,500 |

**Roles:**
- **On-prem AI** — the box hosts Ollama for the free local text AI (assistant,
  translation, triage), removing per-token cost and the free-tier data-sharing
  caveat for those tasks.
- **Backup hosting** — the same (or a second) server runs the full Hawkeye stack
  (Node + SQLite/Postgres) as a hot failover if GO54 is down, behind Cloudflare so
  DNS can fail over. Election-day independence: a self-owned box can't be
  deplatformed.
- **Path to primary** — as scale demands (see MOBILE-APP-ARCHITECTURE.md §4), the
  on-prem server plus S3-compatible object storage for images can become the main
  host, with cloud as the failover — inverting today's setup.

Everything is a **base-URL swap** away: the app, ledger, and Rekor anchoring don't
change; only where they run does.

## Cost summary

- **Now:** $0 — free hosted tiers (Gemini/Groq/Mistral/OpenRouter) + optional
  local Ollama on an existing laptop.
- **Intended (funded, sized for 1M users — see [SCALE-1M](SCALE-1M.md)):**
  **2× NVIDIA DGX Spark** (~$8k) + **Starlink** kit + 12 mo service (~$1.2k) +
  **3 kVA / 3.5 kWp / 10 kWh solar** (~$5k) + networking/spares (~$1k) →
  **~$16,000–19,000** one-time for a redundant, deplatform-proof, off-grid
  failover cluster (Spark A: app + Postgres + 2 TB media mirror; Spark B: AI
  inference + warm standby). A Mac Studio (M3/M4 Ultra, 256 GB) is a valid
  substitute for the inference box only — faster LLM bandwidth, weaker Linux
  server posture. Cloud primary opex: $500–1,500/mo in election windows.
  Ongoing: Starlink ~$50–150/mo. (See investor deck use-of-funds.)
