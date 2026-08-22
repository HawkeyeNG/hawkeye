#!/usr/bin/env bash
# Start (or restart) the vLLM server on the pod.
#
# Separate from the install step so a server that dies can be brought back
# without reinstalling anything. The first attempt died instantly on
# `--disable-log-requests`, which vLLM 0.27 renamed to
# `--no-enable-log-requests`; argparse rejected the whole command line and the
# only evidence was a usage dump in a log nobody would have read if the GPU
# figure had not stayed at 1 MiB.
#
# CONTEXT IS 16384, NOT 8192, BECAUSE OF THE IMAGES. The party-table crop is
# 1080x1420 upscaled 2x, which Qwen turns into roughly 7,800 vision tokens;
# with the prompt and a 15-row reply that overran an 8k window and every single
# request came back 400. The alternative was to shrink the image, but
# magnification is the entire reason the cropped passes read handwriting better
# than the full-sheet one — blurring the votes to save context would trade away
# the thing being bought. (The crop is now enlarged 1.4x rather than 2x, which
# is not a blur: 2x was enlarging a 1080px crop of a 1500px-wide scan to 2160px,
# inventing pixels the paper never held.)
#
# MEMORY IS THE VISION ENCODER'S, NOT THE KV CACHE'S. At 0.94 utilization and
# fourteen requests in flight the engine hit CUDA OOM trying to allocate 812 MiB
# for image activations and took the whole server down mid-run — 50 sheets came
# back 502 and the GPU went to 1 MiB. KV cache sizing does not bound this;
# concurrent IMAGES do. `--max-num-seqs 8` caps the batch server-side so a
# client that asks for too much gets queued rather than killing the engine, and
# 0.86 leaves the encoder room to work in.
export HF_HOME=/workspace/hf
export HUGGINGFACE_HUB_CACHE=/workspace/hf/hub
mkdir -p "$HF_HOME"

# Kill the old server BY PID, and wait for the port to actually free.
#
# `pkill -f <pattern>` is banned in this project: the pattern matches the
# calling shell's own command line and the script kills itself. `pkill -x -f`
# avoids that but requires the pattern to equal the ENTIRE command line, which
# it never does once vLLM's dozen arguments are on it — so the previous server
# survived, kept port 8000, and the restart died in setup_server with a stack
# trace about binding. Bracket the pattern so it cannot match this script, take
# the PIDs, and verify the port is free before starting.
for PID in $(pgrep -f '[a]pi_server --model'); do
  echo "stopping old server pid $PID"
  kill "$PID" 2>/dev/null
done
for _ in $(seq 1 30); do
  ss -ltn 2>/dev/null | grep -q ':8000 ' || break
  sleep 1
done
if ss -ltn 2>/dev/null | grep -q ':8000 '; then
  echo "port 8000 still held; forcing"
  for PID in $(pgrep -f '[a]pi_server --model'); do kill -9 "$PID" 2>/dev/null; done
  sleep 3
fi

setsid nohup python3 -m vllm.entrypoints.openai.api_server \
  --model Qwen/Qwen2.5-VL-7B-Instruct \
  --served-model-name Qwen/Qwen2.5-VL-7B-Instruct \
  --host 0.0.0.0 --port 8000 \
  --max-model-len 8192 \
  --gpu-memory-utilization 0.90 \
  --max-num-seqs 8 \
  --limit-mm-per-prompt '{"image":1}' \
  --no-enable-log-requests \
  > /workspace/vllm.log 2>&1 < /dev/null &

sleep 20
echo "--- first 30 lines of the log ---"
head -30 /workspace/vllm.log
echo "--- is it alive? ---"
pgrep -f '[a]pi_server' >/dev/null && echo "process running" || echo "!! PROCESS ALREADY GONE"
