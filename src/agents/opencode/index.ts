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
        this.ollamaClient = new Ollama({ host: 'http://localhost:11434' });
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
            // 5. Invoke opencode -- evalRunner's withTimeout provides outer timeout protection
            //    Use OPENCODE_BIN_PATH if set (CI setup-opencode action), else bare 'opencode'
            const opencodeBin = process.env.OPENCODE_BIN_PATH || 'opencode';
            const result = await runCommand(`OPENCODE_DISABLE_CLAUDE_CODE_PROMPT=1 OPENCODE_DISABLE_PROJECT_CONFIG=1 OPENCODE_DISABLE_EXTERNAL_SKILLS=1 ${opencodeBin} run "$(cat /tmp/.prompt.md)" < /tmp/.prompt.md`);

            if (result.exitCode !== 0) {
                console.error('[OpenCodeAgent] opencode exited with code:', result.exitCode);
            }

            return result.stdout + '\n' + result.stderr;
        } finally {
            // 6. Unload model and wait for eviction so the LLM grader
            //    (qwen2.5:3b) can load without memory contention.
            //    keep_alive: 0 is async -- the model may still be resident
            //    when the call returns. Poll ollama ps to confirm eviction.
            try {
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
            } catch {
                // Ignore unload errors -- model may already be unloaded
            }
        }
    }
}
