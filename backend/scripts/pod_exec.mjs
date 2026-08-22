/**
 * Run shell commands on a RunPod pod through its JupyterLab kernel API.
 *
 *   POD_ID=... POD_TOKEN=... node scripts/pod_exec.mjs "nvidia-smi; ls /workspace"
 *   POD_ID=... POD_TOKEN=... node scripts/pod_exec.mjs --file setup.sh
 *   POD_ID=... POD_TOKEN=... node scripts/pod_exec.mjs --bg "long running thing"
 *
 * WHY NOT SSH. The pod was migrated after RunPod reclaimed its GPU, and the new
 * one did not inherit the authorized key — both `ssh.runpod.io` and the exposed
 * TCP port refuse the key that worked on the old pod. Jupyter is already
 * running on 8888 and the console hands out its token, so this is the route
 * that needs no change to the user's RunPod account settings.
 *
 * WHY NOT THE JUPYTER TERMINAL UI. A GPU job runs for an hour. Driving it by
 * screenshotting a browser terminal means every check costs a round trip and a
 * guess about what is on screen; a script gets exit codes.
 *
 * Node 22 ships a global WebSocket, so this needs no dependency.
 */
import fs from 'node:fs';

const POD_ID = process.env.POD_ID;
const TOKEN = process.env.POD_TOKEN;
if (!POD_ID || !TOKEN) { console.error('set POD_ID and POD_TOKEN'); process.exit(2); }

const argv = process.argv.slice(2);
const bg = argv.includes('--bg');
const fileIdx = argv.indexOf('--file');
const timeoutMs = Number(process.env.POD_TIMEOUT || 600_000);
let command = fileIdx > -1 ? fs.readFileSync(argv[fileIdx + 1], 'utf8') : argv.filter((a) => !a.startsWith('--')).join(' ');
if (!command.trim()) { console.error('nothing to run'); process.exit(2); }

const BASE = `https://${POD_ID}-8888.proxy.runpod.net`;
const auth = { Authorization: `token ${TOKEN}` };

const api = async (path, init = {}) => {
  const r = await fetch(`${BASE}${path}`, {
    ...init,
    headers: { ...auth, 'content-type': 'application/json', ...(init.headers || {}) },
    signal: AbortSignal.timeout(60_000),
  });
  const text = await r.text();
  if (!r.ok) throw new Error(`${init.method || 'GET'} ${path} -> ${r.status} ${text.slice(0, 200)}`);
  return text ? JSON.parse(text) : null;
};

/**
 * THE SCRIPT IS SHIPPED AS BASE64, NEVER AS AN EMBEDDED STRING.
 *
 * The first version interpolated the command into a `bash -c "..."` through two
 * layers of quoting — JS to Python to bash. JSON.stringify turns a newline into
 * the two characters `\` and `n`, and bash inside double quotes leaves those
 * alone, so a multi-line setup script arrived as one long line of nonsense. It
 * "started" and died instantly, leaving a zero-byte log and no process: a
 * failure that looks exactly like a job still warming up.
 *
 * Base64 has no metacharacters, so there is nothing left for a shell to
 * misread. The script is written to a file and that file is run.
 */
const stamp = Date.now();
const remotePath = `/workspace/pod_cmd_${stamp}.sh`;
const logPath = `/workspace/pod_bg_${stamp}.log`;
const payload = Buffer.from(command, 'utf8').toString('base64');

const setup = [
  'import base64, os, subprocess',
  'os.makedirs("/workspace", exist_ok=True)',
  `open(${JSON.stringify(remotePath)}, "wb").write(base64.b64decode(${JSON.stringify(payload)}))`,
];

// A backgrounded job must survive this script exiting AND the kernel being
// culled, so it is detached with setsid; without it, reaping the kernel takes
// the job down with it.
const runLine = bg
  ? `setsid nohup bash ${remotePath} > ${logPath} 2>&1 < /dev/null & echo "started; log: ${logPath}"`
  : `bash ${remotePath}`;

const kernel = await api('/api/kernels', { method: 'POST', body: JSON.stringify({ name: 'python3' }) });
const ws = new WebSocket(`${BASE.replace('https', 'wss')}/api/kernels/${kernel.id}/channels?token=${TOKEN}`);

const msgId = `exec-${Date.now()}`;
let exitCode = null;
let sawIdle = false;

const cleanup = async () => {
  try { ws.close(); } catch { /* already closed */ }
  try { await api(`/api/kernels/${kernel.id}`, { method: 'DELETE' }); } catch { /* pod may be gone */ }
};

const timer = setTimeout(async () => {
  console.error(`\n[pod_exec] timed out after ${timeoutMs / 1000}s`);
  await cleanup();
  process.exit(3);
}, timeoutMs);

ws.addEventListener('open', () => {
  // Shelling out through subprocess rather than IPython's `!` so the exit code
  // comes back: a command that fails silently is how a broken setup gets
  // mistaken for a working one.
  const code = [
    ...setup,
    'import sys',
    `p = subprocess.run(["bash","-lc", ${JSON.stringify(runLine)}], capture_output=True, text=True)`,
    'sys.stdout.write(p.stdout)',
    'sys.stderr.write(p.stderr)',
    'print("___EXIT___", p.returncode)',
  ].join('\n');
  ws.send(JSON.stringify({
    header: { msg_id: msgId, username: '', session: msgId, msg_type: 'execute_request', version: '5.3' },
    parent_header: {}, metadata: {},
    content: { code, silent: false, store_history: false, user_expressions: {}, allow_stdin: false, stop_on_error: true },
    channel: 'shell',
  }));
});

ws.addEventListener('message', (ev) => {
  let m;
  try { m = JSON.parse(ev.data); } catch { return; }
  if (m.parent_header?.msg_id !== msgId) return;
  const t = m.header?.msg_type;
  if (t === 'stream') {
    const text = m.content.text || '';
    const hit = text.match(/___EXIT___ (\d+)/);
    if (hit) { exitCode = Number(hit[1]); process.stdout.write(text.replace(/___EXIT___ \d+\n?/, '')); }
    else process.stdout.write(text);
  } else if (t === 'error') {
    console.error((m.content.traceback || []).join('\n'));
    exitCode = exitCode ?? 1;
  } else if (t === 'status' && m.content.execution_state === 'idle') {
    sawIdle = true;
  }
});

ws.addEventListener('error', async (e) => {
  console.error(`[pod_exec] websocket error: ${e?.message || e}`);
  clearTimeout(timer);
  await cleanup();
  process.exit(4);
});

// Poll for completion rather than closing on the first idle — the idle status
// can arrive before the last stream chunk on a chatty command.
const started = Date.now();
for (;;) {
  await new Promise((r) => setTimeout(r, 400));
  if (sawIdle && exitCode !== null) break;
  if (sawIdle && Date.now() - started > 5000) break;
  if (Date.now() - started > timeoutMs) break;
}
clearTimeout(timer);
await cleanup();
if (exitCode) console.error(`\n[pod_exec] exit ${exitCode}`);
process.exit(exitCode || 0);
