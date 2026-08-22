#!/usr/bin/env bash
# Rebuild the vLLM serving stack on a freshly migrated pod.
#
# RunPod reclaimed the original pod's GPU and the migration brought across an
# EMPTY /workspace — no vLLM, no model weights, no HuggingFace cache. So this is
# a clean build, not a restart.
#
# Runs unattended via pod_exec.mjs --bg. Every step is loud on failure: a setup
# that half-works produces a server that answers requests and reads sheets
# wrongly, which is far more expensive than one that never starts.
set -o pipefail

echo "=== $(date -u) starting ==="

# The 7B weights are ~16GB. Root is a 30G overlay; /workspace is a 50G volume.
# Putting the cache anywhere but /workspace fills the container and the failure
# surfaces halfway through a download as a confusing permission error.
export HF_HOME=/workspace/hf
export HUGGINGFACE_HUB_CACHE=/workspace/hf/hub
mkdir -p "$HF_HOME"

# Restore key-based SSH so the pod stays reachable if Jupyter dies mid-run.
# Appending to the pod's own authorized_keys, NOT changing any RunPod account
# setting — the account is the user's and its settings are theirs to change.
mkdir -p /root/.ssh && chmod 700 /root/.ssh
KEY="ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIGXTDKVjVnY6oSvPxwcUrM4VX4IojQX245ZsYrb/gQpP osaretinjosagie@outlook.com"
grep -qF "${KEY%% *} AAAAC3NzaC1lZDI1NTE5AAAAIGXTDKVjVnY6oSvPxwcUrM4VX4IojQX245ZsYrb/gQpP" /root/.ssh/authorized_keys 2>/dev/null \
  || echo "$KEY" >> /root/.ssh/authorized_keys
chmod 600 /root/.ssh/authorized_keys
echo "ssh key installed"

echo "=== installing vllm ==="
# Pinned to the 0.27 line: the existing archive was read under it, and mixing
# serving versions across passes of one audit adds a variable nobody can
# measure afterwards. The worker's structured-output probe is the backstop if
# the resolver picks something else.
pip install --no-cache-dir 'vllm==0.27.*' 2>&1 | tail -25
if ! python3 -c 'import vllm' 2>/dev/null; then
  echo "!! vllm==0.27.* did not install; falling back to latest"
  pip install --no-cache-dir vllm 2>&1 | tail -25
fi
python3 -c 'import vllm; print("vllm", vllm.__version__)' || { echo "!! VLLM INSTALL FAILED"; exit 1; }

echo "=== starting server ==="
# 3090 is 24GB and the weights are ~16GB in bf16. max-model-len is kept modest
# because one cropped table image plus this prompt is nowhere near 8k tokens,
# and a large KV cache reservation is what pushes this model off a 24GB card.
setsid nohup python3 -m vllm.entrypoints.openai.api_server \
  --model Qwen/Qwen2.5-VL-7B-Instruct \
  --served-model-name Qwen/Qwen2.5-VL-7B-Instruct \
  --host 0.0.0.0 --port 8000 \
  --max-model-len 8192 \
  --gpu-memory-utilization 0.92 \
  --limit-mm-per-prompt '{"image":1}' \
  --disable-log-requests \
  > /workspace/vllm.log 2>&1 &

echo "server launching; log at /workspace/vllm.log"
echo "=== $(date -u) setup script done (model still downloading) ==="
