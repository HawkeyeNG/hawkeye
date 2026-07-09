# Hawkeye — Self-Hosted AI (Ollama) + On-Prem Infrastructure

*How to run Hawkeye's text-AI locally (laptop now, physical server later) at $0
per-token, and where on-prem infrastructure fits as backup/primary hosting. The
EC8A **vision** check stays on a hosted multimodal model (Gemini) — small local
models can't read result sheets.*

## What can run locally

| Task | Local model works? | Notes |
|---|---|---|
| Results assistant (Q&A) | ⚠ marginal at 3B | needs light tool-use; Qwen2.5-3B is the best small pick, Llama-3.2-3B ok |
| Translation (Hausa/Yoruba/Igbo/Pidgin) | ✅ | small models are fine, no tools |
| Incident triage (kind/urgency/spam) | ✅ | short classify prompt, no tools |
| EC8A vision (read sheet + forgery) | ❌ | keep on Gemini/hosted multimodal |

Recommended small models: **Qwen2.5 3B** (best instruction-following at this size)
or **Llama 3.2 3B**; **Llama 3.2 1B** only for translation/triage, not the
assistant.

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

## Physical server (backup, then primary)

Hardware sizing and rough 2026 costs:

| Tier | Spec | Runs | Approx. cost |
|---|---|---|---|
| Mini-PC | 32 GB RAM, mini GPU/NPU (e.g. Beelink/Minisforum) | app + DB + 3B model on CPU | $350–550 |
| GPU inference box | RTX 4060/4070 16 GB, 32–64 GB RAM | 7–8B models comfortably, 3B fast | $1,500–2,500 |
| Redundant server + UPS | used enterprise/tower + UPS + networking | app/DB failover, election-day resilience | $2,000–4,000 |

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
- **Hardware (funded):** one GPU inference box ≈ $1,500–2,500 + a redundant
  app/DB server ≈ $2,000–4,000 + UPS/networking ≈ $300–500 → **~$4,000–7,000**
  for resilient on-prem AI + backup infrastructure (see investor deck use-of-funds).
