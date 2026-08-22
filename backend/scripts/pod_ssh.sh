#!/usr/bin/env bash
# Run a command on the RunPod pod over SSH.
#   bash pod_ssh.sh <pod-ssh-user> "<remote command>"
# Never prompts: BatchMode means a key that needs a passphrase fails loudly
# instead of hanging on a prompt nobody can answer.
POD_USER="$1"
shift
ssh -o BatchMode=yes \
    -o StrictHostKeyChecking=no \
    -o UserKnownHostsFile=/dev/null \
    -o ConnectTimeout=20 \
    -o LogLevel=ERROR \
    "${POD_USER}@ssh.runpod.io" "$@"
