import { Ollama } from 'ollama';
import { BaseAgent, CommandResult } from '../../types';
import { DEFAULT_OLLAMA_AGENT_CONFIG } from '../ollama/types';
import * as path from 'path';
import * as fs from 'fs';

/**
 * OpenCodeAgent -- wraps the `opencode run` CLI with config injection,
 * timeout protection, and Ollama model unload.
 *
 * Follows the established CLI agent pattern (GeminiAgent/ClaudeAgent) with
 * three additions:
 * 1. Config injection: copies opencode.json into workspace CWD before launch
 * 2. Timeout wrapper: uses bash `timeout` command for hang protection
 * 3. Model unload: calls keep_alive: 0 in finally block after run completes
 */
export class OpenCodeAgent extends BaseAgent {
    private ollamaClient: Ollama;
    private defaultTimeoutSec: number = 540; // 90% of 600s task timeout

    constructor() {
        super();
        this.ollamaClient = new Ollama({ host: DEFAULT_OLLAMA_AGENT_CONFIG.host });
    }

    async run(
        instruction: string,
        _workspacePath: string,
        runCommand: (cmd: string) => Promise<CommandResult>
    ): Promise<string> {
        // 1. Inject opencode.json config into workspace
        const configContent = fs.readFileSync(
            path.join(__dirname, 'opencode.skill-eval-agent.json'),
            'utf-8'
        );
        const b64Config = Buffer.from(configContent).toString('base64');
        await runCommand(`echo '${b64Config}' | base64 -d > opencode.json`);

        // 2. Log model for diagnostics
        console.log(`[OpenCodeAgent] Using model: ${DEFAULT_OLLAMA_AGENT_CONFIG.model}`);

        // 3. Write instruction to temp file (established base64 pattern)
        const b64 = Buffer.from(instruction).toString('base64');
        await runCommand(`echo '${b64}' | base64 -d > /tmp/.prompt.md`);

        try {
            // 4. Invoke opencode with timeout wrapper for hang protection
            const timeoutSec = this.defaultTimeoutSec;
            const command = `timeout --signal=TERM --kill-after=10 ${timeoutSec} opencode run "$(cat /tmp/.prompt.md)"`;
            const result = await runCommand(command);

            if (result.exitCode === 124) {
                console.error(`[OpenCodeAgent] opencode killed by timeout after ${timeoutSec}s`);
            } else if (result.exitCode === 127) {
                // timeout command not found -- fall back to running without timeout wrapper
                console.warn('[OpenCodeAgent] timeout command not available, running without timeout wrapper');
                const fallbackCommand = `opencode run "$(cat /tmp/.prompt.md)"`;
                const fallbackResult = await runCommand(fallbackCommand);

                if (fallbackResult.exitCode !== 0) {
                    console.error('[OpenCodeAgent] opencode exited with code:', fallbackResult.exitCode);
                }

                return fallbackResult.stdout + '\n' + fallbackResult.stderr;
            } else if (result.exitCode !== 0) {
                console.error('[OpenCodeAgent] opencode exited with code:', result.exitCode);
            }

            return result.stdout + '\n' + result.stderr;
        } finally {
            // 5. Unload model (safety net, same pattern as OllamaToolAgent)
            try {
                await this.ollamaClient.chat({
                    model: DEFAULT_OLLAMA_AGENT_CONFIG.model,
                    messages: [],
                    keep_alive: 0,
                });
            } catch {
                // Ignore unload errors -- model may already be unloaded
            }
        }
    }
}
