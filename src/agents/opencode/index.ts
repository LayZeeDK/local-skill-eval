import { Ollama } from 'ollama';
import { BaseAgent, CommandResult } from '../../types';
import * as path from 'path';
import * as fs from 'fs';

/**
 * Model name used by opencode. Uses qwen3:4b because:
 * - Fastest avg duration (78.9s) with tightest variance (11s spread) in 5-trial eval
 * - All 3 candidates scored reward 1.00; qwen3:4b had best consistency (78.9s avg, 11s spread)
 * - 2.5 GB loaded -- no OOM on 32 GB machine even with qwen2.5:3b grader
 * - Only Qwen3 family produces structured tool calls on Ollama
 * NO custom system prompt -- opencode provides its own via the OpenAI-compatible API.
 */
const OPENCODE_MODEL = 'qwen3-4b-skill-eval-opencode-agent';

/**
 * OpenCodeAgent -- wraps the `opencode run` CLI with config injection,
 * git init for project detection, and Ollama model unload.
 *
 * Follows the established CLI agent pattern with three additions:
 * 1. Config injection: copies opencode.json into workspace CWD before launch
 * 2. Git init: opencode uses git root detection for project config lookup
 * 3. Model unload: calls keep_alive: 0 in finally block after run completes
 *
 * Timeout protection is provided by the evalRunner's withTimeout wrapper.
 */
export class OpenCodeAgent extends BaseAgent {
    private ollamaClient: Ollama;

    constructor() {
        super();
        this.ollamaClient = new Ollama({ host: 'http://127.0.0.1:11434' });
    }

    async run(
        instruction: string,
        _workspacePath: string,
        runCommand: (cmd: string) => Promise<CommandResult>
    ): Promise<string> {
        // 1. Inject opencode.json config into workspace
        //    Detect Docker context and adjust baseURL for host.docker.internal
        const configJson = JSON.parse(fs.readFileSync(
            path.join(__dirname, 'opencode.skill-eval-agent.json'),
            'utf-8'
        ));

        // Primary: /.dockerenv exists in every Docker container (works on cgroupv1 and cgroupv2)
        const dockerenvResult = await runCommand('test -f /.dockerenv && echo yes || echo no');
        let inDocker = dockerenvResult.stdout.trim() === 'yes';

        if (!inDocker) {
            // Fallback: cgroup v1 detection
            const cgroupResult = await runCommand('cat /proc/1/cgroup 2>/dev/null | head -1');
            inDocker = cgroupResult.stdout.includes('docker')
                || cgroupResult.stdout.includes('kubepods');
        }

        if (!inDocker) {
            // Also check for /workspace path pattern typical of Docker containers
            const pwdResult = await runCommand('pwd');
            const cwd = pwdResult.stdout.trim();

            if (cwd.startsWith('/workspace') && process.platform !== 'linux') {
                inDocker = true;
                console.log('[OpenCodeAgent] Docker context detected (workspace path) -- using host.docker.internal');
            }
        } else {
            console.log('[OpenCodeAgent] Docker context detected -- using host.docker.internal');
        }

        if (inDocker) {
            configJson.provider.ollama.options.baseURL = 'http://host.docker.internal:11434/v1';

            // Install opencode inside the container if not already present
            const whichResult = await runCommand('which opencode 2>/dev/null');

            if (whichResult.exitCode !== 0) {
                console.log('[OpenCodeAgent] Installing opencode inside Docker container...');
                const installResult = await runCommand('npm install -g opencode-ai 2>&1');

                if (installResult.exitCode !== 0) {
                    console.error('[OpenCodeAgent] Failed to install opencode:', installResult.stdout);
                }

                // Log where npm installed the binary
                const verifyResult = await runCommand('which opencode 2>/dev/null || echo "NOT_FOUND"; echo "npm prefix: $(npm prefix -g)"; echo "PATH=$PATH"');
                console.log('[OpenCodeAgent] Docker opencode install verify:', verifyResult.stdout.trim());
            }
        }

        const configStr = JSON.stringify(configJson, null, 2);
        const b64Config = Buffer.from(configStr).toString('base64');
        await runCommand(`echo '${b64Config}' | base64 -d > opencode.json`);

        // 2. Initialize git repo -- opencode uses git root for project config lookup
        await runCommand('git init -q 2>/dev/null || true');

        // 3. Log model for diagnostics
        console.log(`[OpenCodeAgent] Using model: ${OPENCODE_MODEL}`);

        // 4. Write instruction to temp file (established base64 pattern)
        //    Prefix with a directive to use bash tools — small models try to
        //    invoke opencode's "Skill" system instead of running bash commands.
        const prefixedInstruction = [
            'CRITICAL: Execute ALL commands below in order. After each command completes, immediately run the next one. Do NOT stop, summarize, or explain between commands.',
            'You have 4 tools: Bash, Read, Edit, Write. Use Bash for ALL shell commands.',
            'IMPORTANT: When calling bash, you MUST provide both "command" and "description" fields. Example: {"command": "ls -la", "description": "List files in workspace"}',
            'After the last command, respond with a one-line summary.',
            '/no_think\n',
            instruction,
        ].join('\n');
        const b64 = Buffer.from(prefixedInstruction).toString('base64');
        await runCommand(`echo '${b64}' | base64 -d > /tmp/.prompt.md`);

        try {
            // 5. Invoke opencode with process-level timeout protection.
            //    evalRunner's withTimeout is promise-level only — it rejects the
            //    JS promise but cannot kill the spawned child process, leaving
            //    orphaned opencode/Ollama processes that block CI job cleanup.
            //    On Linux, wrap with coreutils `timeout` to SIGTERM → SIGKILL
            //    the entire process group.  On Windows (Git Bash), `timeout` is
            //    a different command; rely on evalRunner's promise timeout there.
            //    Use OPENCODE_BIN_PATH for local provider (CI setup-opencode sets it);
            //    inside Docker, opencode is installed in-container and on PATH.
            const opencodeBinRaw = (!inDocker && process.env.OPENCODE_BIN_PATH) || 'opencode';
            // Convert Windows backslashes to forward slashes — Git Bash
            // interprets backslashes as escape sequences in command strings.
            const opencodeBin = opencodeBinRaw.replace(/\\/g, '/');
            // Unset NODE_OPTIONS — V8-specific flags (e.g. --max-old-space-size)
            // leak into Bun (opencode's runtime, JavaScriptCore) and can cause
            // OOM on memory-constrained runners by inflating the parent Node.js
            // heap alongside Ollama's model (~2.5 GB).
            const envVars = 'OPENCODE_DISABLE_CLAUDE_CODE_PROMPT=1 OPENCODE_DISABLE_PROJECT_CONFIG=1 OPENCODE_DISABLE_EXTERNAL_SKILLS=1';
            // Redirect stdin from /dev/null so Bun.stdin.text() gets
            // immediate EOF instead of blocking on Node.js spawn's pipe.
            //
            // On Linux, the local provider spawns bash with pipe stdio
            // (no TTY).  libc then uses full buffering (~4-8 KB) for
            // stdout/stderr.  If `timeout` kills opencode before the
            // buffer fills, the output never reaches the pipe → 0 bytes.
            // The Docker provider avoids this with `Tty: true` in exec.
            //
            // Fix: redirect all output to a file and read it back after
            // the command completes (or is killed by timeout).  Even if
            // the process buffer isn't fully flushed, any previously-
            // flushed content is preserved in the file.
            // 300s timeout accommodates ARM64 CI Ollama inference speed.
            const ocOutFile = '/tmp/.opencode-output.log';
            let fullCmd: string;

            if (process.platform !== 'win32') {
                const opencodeRun = `${opencodeBin} run "$(cat /tmp/.prompt.md)" < /dev/null`;
                // Use `unbuffer -p` to force line-buffered output via PTY.
                // Without it, libc uses full buffering (~4-8 KB) when stdout
                // is a file/pipe.  If timeout kills the process before the
                // buffer fills, output is lost (0 bytes).  unbuffer allocates
                // a per-command PTY that forces line buffering at the kernel
                // level.  Falls back to plain execution if unbuffer isn't
                // installed (output may be lost on timeout kill).
                const unbuf = 'command -v unbuffer >/dev/null 2>&1 && echo unbuffer -p';
                fullCmd = `unset NODE_OPTIONS; ${envVars} timeout --signal=TERM --kill-after=10 300 $(${unbuf}) ${opencodeRun} > ${ocOutFile} 2>&1`;
            } else {
                fullCmd = `${envVars} ${opencodeBin} run "$(cat /tmp/.prompt.md)" < /dev/null`;
            }

            console.log('[OpenCodeAgent] Running:', fullCmd.slice(0, 250));
            const result = await runCommand(fullCmd);
            // exit 124 = timeout sent SIGTERM (expected on ARM64 Linux where
            // Bun hangs after completing work).  The agent output is still valid.
            const killedByTimeout = result.exitCode === 124 || result.exitCode === 137;

            // On Linux, read output from file.  On Windows, use pipe output.
            let output: string;

            if (process.platform !== 'win32') {
                const fileResult = await runCommand(`cat ${ocOutFile} 2>/dev/null || true`);
                output = fileResult.stdout;
                console.log('[OpenCodeAgent] Read output from file:', output.length, 'bytes');
            } else {
                output = result.stdout + (result.stderr ? '\n' + result.stderr : '');
            }

            console.log(
                '[OpenCodeAgent] exit:', result.exitCode,
                killedByTimeout ? '(killed by timeout -- expected Bun ARM64 hang)' : '',
                'output:', output.length, 'bytes',
            );

            if (result.exitCode !== 0 && !killedByTimeout) {
                console.error('[OpenCodeAgent] output (tail):', output.slice(-500));
            }

            return output;
        } finally {
            // 6. Unload model and wait for eviction so the LLM grader
            //    (qwen2.5:3b) can load without memory contention.
            //    keep_alive: 0 is async -- the model may still be resident
            //    when the call returns. Poll ollama ps to confirm eviction.
            //    Wrap in a 30s hard timeout -- if Ollama is unreachable, the
            //    HTTP calls hang forever, keeping Node.js alive and blocking
            //    CI job cleanup.
            try {
                await Promise.race([
                    (async () => {
                        await this.ollamaClient.chat({
                            model: OPENCODE_MODEL,
                            messages: [],
                            keep_alive: 0,
                        });

                        const maxWaitMs = 15_000;
                        const pollMs = 500;
                        const deadline = Date.now() + maxWaitMs;

                        while (Date.now() < deadline) {
                            const ps = await this.ollamaClient.ps();
                            const still = ps.models.some(m => m.name.startsWith(OPENCODE_MODEL));

                            if (!still) {
                                break;
                            }

                            await new Promise(r => setTimeout(r, pollMs));
                        }
                    })(),
                    new Promise((_, reject) =>
                        setTimeout(() => reject(new Error('Model unload timed out')), 30_000)
                    ),
                ]);
            } catch {
                // Ignore unload errors -- model may already be unloaded
            }
        }
    }
}
