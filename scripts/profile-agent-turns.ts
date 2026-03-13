#!/usr/bin/env npx ts-node
/**
 * Per-turn Ollama metric profiler for the agent.
 *
 * Runs a simplified agent loop against the Ollama chat API to capture
 * per-turn metrics (eval_count, eval_duration, prompt_eval_count, etc.).
 * Uses the same system prompt, tools, and model as the real agent but
 * with instrumented metric capture.
 *
 * This does NOT use OllamaToolAgent -- it is a separate profiling tool.
 *
 * Usage:
 *   npx ts-node scripts/profile-agent-turns.ts
 *   npx ts-node scripts/profile-agent-turns.ts --max-turns 10
 */

import { Ollama, ChatResponse } from 'ollama';
import * as fs from 'fs';
import * as fse from 'fs-extra';
import * as path from 'path';
import { execSync } from 'child_process';

// Re-use the real agent tool definitions and config
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { AGENT_TOOLS } = require('../src/agents/ollama/tools');
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { DEFAULT_OLLAMA_AGENT_CONFIG } = require('../src/agents/ollama/types');

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface TurnMetrics {
    turn: number;
    prompt_eval_count: number;
    prompt_eval_ms: number;
    eval_count: number;
    eval_ms: number;
    load_ms: number;
    total_ms: number;
    tool_calls: number;
}

// ---------------------------------------------------------------------------
// CLI argument parsing
// ---------------------------------------------------------------------------

function printUsage(): void {
    const usage = `
profile-agent-turns.ts -- Per-turn Ollama metric profiler

Usage:
  npx ts-node scripts/profile-agent-turns.ts [options]

Options:
  --max-turns <N>   Maximum agent turns (default: 15)
  --help, -h        Show this help
`.trim();
    console.error(usage);
}

function parseArgs(argv: string[]): { maxTurns: number } | null {
    let maxTurns = 15;

    for (let i = 0; i < argv.length; i++) {
        const arg = argv[i];

        if (arg === '--help' || arg === '-h') {
            return null;
        }

        if (arg === '--max-turns' && i + 1 < argv.length) {
            maxTurns = parseInt(argv[++i], 10);
        }
    }

    return { maxTurns };
}

// ---------------------------------------------------------------------------
// Nanoseconds to milliseconds
// ---------------------------------------------------------------------------

function nsToMs(ns: number): number {
    return Math.round(ns / 1_000_000);
}

// ---------------------------------------------------------------------------
// Minimal tool executor (for profiling only -- no permission system)
// ---------------------------------------------------------------------------

function executeToolCall(
    name: string,
    args: Record<string, unknown>,
    workspaceRoot: string
): string {
    try {
        switch (name) {
            case 'read_file': {
                const filePath = path.resolve(workspaceRoot, args.path as string);

                return fs.readFileSync(filePath, 'utf-8').substring(0, 8000);
            }

            case 'write_file': {
                const filePath = path.resolve(workspaceRoot, args.path as string);
                fse.ensureDirSync(path.dirname(filePath));
                fs.writeFileSync(filePath, args.content as string, 'utf-8');

                return `File written: ${args.path}`;
            }

            case 'list_directory': {
                const dirPath = path.resolve(workspaceRoot, args.path as string);
                const entries = fs.readdirSync(dirPath);

                return entries.join('\n');
            }

            case 'bash': {
                const command = args.command as string;
                const timeout = typeof args.timeout === 'number' ? args.timeout * 1000 : 60_000;

                try {
                    const result = execSync(command, {
                        cwd: workspaceRoot,
                        encoding: 'utf-8',
                        timeout,
                        stdio: 'pipe',
                    });

                    return `stdout:\n${result}\nstderr:\n\nexit code: 0`.substring(0, 8000);
                } catch (err: any) {
                    const stdout = err.stdout || '';
                    const stderr = err.stderr || '';

                    return `stdout:\n${stdout}\nstderr:\n${stderr}\nexit code: ${err.status || 1}`.substring(0, 8000);
                }
            }

            default:
                return `Error: Unknown tool "${name}"`;
        }
    } catch (err: any) {
        return `Error: ${err.message}`;
    }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
    const args = parseArgs(process.argv.slice(2));

    if (!args) {
        printUsage();
        process.exit(0);
    }

    const modelName = DEFAULT_OLLAMA_AGENT_CONFIG.model as string;
    const client = new Ollama({ host: DEFAULT_OLLAMA_AGENT_CONFIG.host });

    // System prompt -- same as the real agent
    const systemPrompt =
        'You are an AI agent that completes coding tasks. Use the provided tools to complete the task. ' +
        'Do not explain your reasoning - just call the appropriate tool. ' +
        'When you are done, respond with a summary of what you did. /no_think';

    // Load the task instruction
    const instructionPath = path.resolve(__dirname, '..', 'tasks', 'superlint_demo', 'instruction.md');
    const instruction = fs.readFileSync(instructionPath, 'utf-8');

    // Create a temporary workspace copy to avoid modifying the real task files
    const tmpDir = path.resolve(__dirname, '..', '.tmp-profile-workspace');

    if (fse.existsSync(tmpDir)) {
        fse.removeSync(tmpDir);
    }

    const taskSrc = path.resolve(__dirname, '..', 'tasks', 'superlint_demo');
    fse.copySync(taskSrc, tmpDir);

    console.error(`[INFO] Profiling model "${modelName}" on superlint_demo`);
    console.error(`[INFO] Workspace copy: ${tmpDir}`);
    console.error(`[INFO] Max turns: ${args.maxTurns}`);
    console.error('');

    const messages: Array<{ role: string; content: string; tool_calls?: any[] }> = [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: instruction },
    ];

    const metrics: TurnMetrics[] = [];

    try {
        for (let turn = 1; turn <= args.maxTurns; turn++) {
            const response: ChatResponse = await client.chat({
                model: modelName,
                messages: messages as any,
                tools: AGENT_TOOLS,
                stream: false,
                think: false,
            });

            const turnMetric: TurnMetrics = {
                turn,
                prompt_eval_count: (response as any).prompt_eval_count ?? 0,
                prompt_eval_ms: nsToMs((response as any).prompt_eval_duration ?? 0),
                eval_count: (response as any).eval_count ?? 0,
                eval_ms: nsToMs((response as any).eval_duration ?? 0),
                load_ms: nsToMs((response as any).load_duration ?? 0),
                total_ms: nsToMs((response as any).total_duration ?? 0),
                tool_calls: response.message.tool_calls?.length ?? 0,
            };

            metrics.push(turnMetric);

            console.error(
                `  Turn ${turn}: prompt_eval=${turnMetric.prompt_eval_count}tok/${turnMetric.prompt_eval_ms}ms ` +
                `eval=${turnMetric.eval_count}tok/${turnMetric.eval_ms}ms ` +
                `total=${turnMetric.total_ms}ms tools=${turnMetric.tool_calls}`
            );

            const toolCalls = response.message.tool_calls;

            if (!toolCalls || toolCalls.length === 0) {
                console.error(`[INFO] Agent finished at turn ${turn} (no more tool calls)`);
                break;
            }

            // Push assistant message with tool calls
            messages.push({
                role: 'assistant',
                content: response.message.content || '',
                tool_calls: toolCalls,
            });

            // Execute each tool call
            for (const toolCall of toolCalls) {
                const name = toolCall.function.name;
                const fnArgs = toolCall.function.arguments as Record<string, unknown>;
                const result = executeToolCall(name, fnArgs, tmpDir);

                messages.push({
                    role: 'tool',
                    content: result,
                });
            }
        }
    } finally {
        // Unload model
        try {
            await client.chat({ model: modelName, messages: [], keep_alive: 0 });
        } catch {
            // Ignore unload errors
        }

        // Clean up temp workspace
        try {
            fse.removeSync(tmpDir);
            console.error('[INFO] Cleaned up temp workspace');
        } catch {
            console.error(`[WARN] Could not clean up ${tmpDir}`);
        }
    }

    // Print markdown table to stdout
    console.log('');
    console.log('| Turn | prompt_eval_count | prompt_eval_ms | eval_count | eval_ms | load_ms | total_ms | tool_calls |');
    console.log('|------|------------------|----------------|------------|---------|---------|----------|------------|');

    for (const m of metrics) {
        console.log(
            `| ${m.turn} | ${m.prompt_eval_count} | ${m.prompt_eval_ms} | ${m.eval_count} | ${m.eval_ms} | ${m.load_ms} | ${m.total_ms} | ${m.tool_calls} |`
        );
    }

    // Totals and averages
    const totalPromptEval = metrics.reduce((s, m) => s + m.prompt_eval_ms, 0);
    const totalEval = metrics.reduce((s, m) => s + m.eval_ms, 0);
    const totalLoad = metrics.reduce((s, m) => s + m.load_ms, 0);
    const totalDuration = metrics.reduce((s, m) => s + m.total_ms, 0);
    const totalToolCalls = metrics.reduce((s, m) => s + m.tool_calls, 0);
    const totalPromptTokens = metrics.reduce((s, m) => s + m.prompt_eval_count, 0);
    const totalEvalTokens = metrics.reduce((s, m) => s + m.eval_count, 0);
    const n = metrics.length;

    console.log(
        `| **Total** | **${totalPromptTokens}** | **${totalPromptEval}** | **${totalEvalTokens}** | **${totalEval}** | **${totalLoad}** | **${totalDuration}** | **${totalToolCalls}** |`
    );
    console.log(
        `| **Avg** | **${Math.round(totalPromptTokens / n)}** | **${Math.round(totalPromptEval / n)}** | **${Math.round(totalEvalTokens / n)}** | **${Math.round(totalEval / n)}** | **${Math.round(totalLoad / n)}** | **${Math.round(totalDuration / n)}** | **${(totalToolCalls / n).toFixed(1)}** |`
    );

    console.log('');
    console.log(`Total turns: ${n}`);
    console.log(`Total wall-clock (Ollama): ${(totalDuration / 1000).toFixed(1)}s`);
    console.log(`Prompt eval: ${(totalPromptEval / 1000).toFixed(1)}s (${((totalPromptEval / totalDuration) * 100).toFixed(1)}% of total)`);
    console.log(`Generation:  ${(totalEval / 1000).toFixed(1)}s (${((totalEval / totalDuration) * 100).toFixed(1)}% of total)`);
    console.log(`Model load:  ${(totalLoad / 1000).toFixed(1)}s (${((totalLoad / totalDuration) * 100).toFixed(1)}% of total)`);
}

main().catch(err => {
    console.error(`[ERROR] ${err}`);
    process.exit(1);
});
