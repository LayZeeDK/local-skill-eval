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
const OLLAMA_HOST = 'http://127.0.0.1:11434';

export class OpenCodeAgent extends BaseAgent {

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
        await runCommand(`echo '${b64}' | base64 -d > .prompt.md`);

        try {
            // 5. Invoke opencode with process-level timeout protection.
            //    evalRunner's withTimeout is promise-level only — it rejects the
            //    JS promise but cannot kill the spawned child process, leaving
            //    orphaned opencode/Ollama processes that block CI job cleanup.
            //    Use OPENCODE_BIN_PATH for local provider (CI setup-opencode sets it);
            //    inside Docker, opencode is installed in-container and on PATH.
            const opencodeBinRaw = (!inDocker && process.env.OPENCODE_BIN_PATH) || 'opencode';
            // Convert Windows backslashes to forward slashes — Git Bash
            // interprets backslashes as escape sequences in command strings.
            const opencodeBin = opencodeBinRaw.replace(/\\/g, '/');

            // Pre-flight: verify config injection and binary reachability before
            // entering the script PTY wrapper, where diagnosis is harder.
            const configCheck = await runCommand('cat opencode.json 2>/dev/null | head -5 || echo "[WARN] opencode.json missing"');
            console.log('[OpenCodeAgent] opencode.json (head):', configCheck.stdout.slice(0, 300).trim());

            const versionCheck = await runCommand(`unset NODE_OPTIONS; timeout 10 ${opencodeBin} --version 2>&1 || echo "[WARN] --version failed/timed-out"`);
            console.log('[OpenCodeAgent] --version:', versionCheck.stdout.slice(0, 100).trim());

            // Unset NODE_OPTIONS — V8-specific flags (e.g. --max-old-space-size)
            // leak into Bun (opencode's runtime, JavaScriptCore) and can cause
            // OOM on memory-constrained runners by inflating the parent Node.js
            // heap alongside Ollama's model (~2.5 GB).
            const envVars = 'OPENCODE_DISABLE_CLAUDE_CODE_PROMPT=1 OPENCODE_DISABLE_EXTERNAL_SKILLS=1';

            // Approach 11: PTY stdout + /dev/null stdin via script --flush.
            //
            // On the GHA ARM64 runner, opencode (Bun/JavaScriptCore) produces
            // zero bytes to pipe stdout — confirmed by smoke tests L4/L4b/L4c
            // (0 bytes even with explicit < /dev/null). Docker works because
            // docker exec Tty:true gives opencode a PTY stdout that Bun
            // flushes synchronously.
            //
            // script --flush allocates a real PTY for stdout and captures
            // output to a typescript file. We redirect opencode's stdin to
            // /dev/null INSIDE the script -c command so Bun.stdin.text()
            // gets immediate EOF (not a PTY, which triggers TUI mode).
            //
            // On Windows/macOS (local dev), script is not used — pipe stdout
            // works fine there.  Docker provider already has Tty:true.
            const isLinuxLocal = !inDocker && process.platform !== 'win32';
            const ocOutFile = '/tmp/.opencode-output.log';
            // Inner command: shell interprets VAR=value prefix and < /dev/null redirect.
            const opencodeRun = `${envVars} ${opencodeBin} run "$(cat .prompt.md)" < /dev/null`;
            let fullCmd: string;

            if (isLinuxLocal) {
                // script --flush: PTY stdout captured to ocOutFile.
                // -q suppresses headers on some distros (Ubuntu 24.04 still
                // prints them — we strip them when reading the file).
                // -e returns the child's exit code.
                // The ; kill 0 ensures PTY process group is cleaned up after
                // opencode exits, preventing orphaned Ollama workers from
                // holding the PTY slave fd open (which makes script hang).
                const scriptCmd = `script -q -e --flush -c '${opencodeRun}; kill 0 2>/dev/null' ${ocOutFile}`;
                fullCmd = `unset NODE_OPTIONS; timeout --kill-after=10 240 ${scriptCmd}`;
            } else {
                fullCmd = opencodeRun;
            }

            console.log('[OpenCodeAgent] Running:', fullCmd.slice(0, 250));
            const result = await runCommand(fullCmd);

            const exitCode = result.exitCode;
            // exit 124 = timeout sent SIGTERM; exit 137 = SIGKILL (--kill-after).
            const killedByTimeout = exitCode === 124 || exitCode === 137;

            let output: string;

            if (isLinuxLocal) {
                // Read from script's typescript file. Strip "Script started..."
                // and "Script done..." header/footer lines that Ubuntu 24.04
                // writes even with -q flag.
                const fileResult = await runCommand(
                    `sed '/^Script started/d; /^Script done/d' ${ocOutFile} 2>/dev/null || true`,
                );
                output = fileResult.stdout;
            } else {
                output = result.stdout + (result.stderr ? '\n' + result.stderr : '');
            }

            console.log(
                '[OpenCodeAgent] exit:', exitCode,
                killedByTimeout ? '(killed by timeout)' : '',
                'output:', output.length, 'bytes',
            );

            if (exitCode !== 0) {
                // Log tail in all failure cases including timeout -- helps diagnose
                // what opencode was doing during the 240s window.
                console.error('[OpenCodeAgent] output (tail):', output.slice(-1000));
            }

            return output;
        } finally {
            // 6. Unload model and wait for eviction so the LLM grader
            //    (qwen2.5:3b) can load without memory contention.
            //    keep_alive: 0 is async -- the model may still be resident
            //    when the call returns. Poll /api/ps to confirm eviction.
            //    Use fetch() with AbortSignal.timeout() on every call --
            //    the Ollama SDK does not propagate AbortSignal for non-
            //    streaming requests, leaving the underlying TCP connection
            //    open until undici's default 300s headersTimeout fires and
            //    keeping Node.js alive long after we intended to exit.
            try {
                await fetch(`${OLLAMA_HOST}/api/chat`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ model: OPENCODE_MODEL, messages: [], keep_alive: 0, stream: false }),
                    signal: AbortSignal.timeout(10_000),
                });

                const maxWaitMs = 15_000;
                const pollMs = 500;
                const deadline = Date.now() + maxWaitMs;

                while (Date.now() < deadline) {
                    const ps = await fetch(`${OLLAMA_HOST}/api/ps`, {
                        signal: AbortSignal.timeout(5_000),
                    }).then(r => r.json() as Promise<{ models: Array<{ name: string }> }>);
                    const still = ps.models.some(m => m.name.startsWith(OPENCODE_MODEL));

                    if (!still) {
                        break;
                    }

                    await new Promise(r => setTimeout(r, pollMs));
                }
            } catch {
                // Ignore unload errors -- model may already be unloaded
            }
        }
    }
}
