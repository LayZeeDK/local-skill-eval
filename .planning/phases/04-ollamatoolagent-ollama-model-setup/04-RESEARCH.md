# Phase 4: OllamaToolAgent + Ollama Model Setup - Research

**Researched:** 2026-03-10
**Domain:** Ollama API tool calling, agentic loop design, local LLM configuration
**Confidence:** HIGH

## Summary

This phase builds an `OllamaToolAgent` that uses Ollama's native `/api/chat` endpoint with structured tool calling to execute agent tasks. The agent implements a tool-calling loop with four tools (`read_file`, `write_file`, `bash`, `list_directory`), a three-tier permission system for bash commands, and path-scoping for file operations. The Ollama `ollama` npm package (v0.6.3) provides typed TypeScript bindings for the chat API including tool call handling.

The primary model candidate is `qwen3:8b`, which supports native tool calling via Ollama's API. Qwen3-8B has a native context window of 32,768 tokens but Ollama defaults to only 2,048 tokens -- a custom Modelfile with `num_ctx 16384` is required for agentic workflows on 16GB RAM hardware. Sequential model loading (agent unloaded before grader) is achieved via `keep_alive: 0` on the final agent API call or `ollama stop` command.

**Primary recommendation:** Use the `ollama` npm package for typed API access, create a custom Modelfile with `num_ctx 16384`, disable thinking mode via `think: false` API parameter for deterministic tool calling, and implement a simple iterative tool-calling loop that checks `response.message.tool_calls` on each turn.

<user_constraints>
## User Constraints (from CONTEXT.md)

### Locked Decisions
- Four tools: `read_file`, `write_file`, `bash`, `list_directory` (snake_case naming)
- Bash runs unrestricted within the provider sandbox (Docker container or LocalProvider temp dir)
- File tools (`read_file`, `write_file`, `list_directory`) are path-scoped to the workspace root -- reject any resolved path outside the workspace boundary (path traversal defense)
- Three-tier permission model:
  1. **Built-in secure denylist** (hardcoded, immutable) -- dangerous bash patterns that can never be overridden
  2. **OllamaAgent defaults** -- sensible default allow/deny lists
  3. **task.toml overrides** -- per-task `[agent.permissions]` with allow/deny arrays, merged with agent defaults
- Permission syntax uses `bash(command *)` glob patterns (inspired by Claude Code's `Bash(pattern)` syntax in settings.json)
- Built-in secure denylist always takes precedence -- task.toml can loosen or tighten agent defaults but cannot bypass the hardcoded denylist
- `node:vm` and `@anthropic-ai/sandbox-runtime` investigated and rejected
- Primary candidate: qwen3:8b
- If qwen3:8b fails the smoke test, researcher identifies 1-2 fallback candidates

### Claude's Discretion
- Agent loop behavior: max iterations handling, text-to-tool-call fallback parsing, system prompt content, conversation history/context window management
- Model configuration: context window size for custom Modelfile, model unload strategy (explicit vs auto-evict)
- Smoke test gate: test scope (single tool call vs multi-step), failure behavior (abort vs retry)
- Tool output truncation limits
- Tool parameter schemas (line ranges for read_file, timeout for bash, append mode for write_file)
- Tool response format (raw text vs JSON)

### Deferred Ideas (OUT OF SCOPE)
- `@anthropic-ai/sandbox-runtime` integration for Linux-only OS-level sandboxing
- Configurable tool set per task (beyond permissions -- actually different tools)
- MCP-style tool definitions
</user_constraints>

<phase_requirements>
## Phase Requirements

| ID | Description | Research Support |
|----|-------------|-----------------|
| AGENT-01 | OllamaToolAgent executes tasks via direct Ollama API with tool calling (read_file, write_file, bash, list_directory) | Ollama `/api/chat` with `tools` parameter; `ollama` npm v0.6.3 provides typed TS bindings; tool-calling loop pattern documented |
| OLCFG-01 | Ollama model identified and configured that supports tool calling for agent tasks | qwen3:8b confirmed as tool-calling capable; fallback candidates: llama3.1:8b, mistral-nemo |
| OLCFG-02 | Custom Modelfile overrides Ollama's 4K default context to a working size for agentic workflows | Modelfile with `PARAMETER num_ctx 16384`; Ollama defaults to 2048 which breaks multi-turn tool loops |
| OLCFG-03 | Sequential model loading prevents OOM -- agent model unloaded before grader loads | `keep_alive: 0` on final API call or `ollama stop <model>` command; 5-minute default timeout also works as safety net |
| PIPE-01 | `--agent=ollama` CLI flag selects OllamaToolAgent as the agent backend | Extend existing `agentType` switch in `src/cli.ts:187` alongside `gemini` and `claude` |
| PIPE-03 | Tool-calling smoke test gates evaluation -- catches misconfigured models before starting a trial | Single tool call test (e.g., `list_directory` on workspace root) verifies model produces structured `tool_calls` response |
</phase_requirements>

## Standard Stack

### Core
| Library | Version | Purpose | Why Standard |
|---------|---------|---------|--------------|
| `ollama` | 0.6.3 | Typed Ollama API client for Node.js | Official Ollama JS library; typed `chat()` method with `tools` parameter and `tool_calls` response; zero config needed beyond `npm i ollama` |
| `picomatch` | 4.0.3 | Glob pattern matching for permission system | Blazing fast, zero dependencies, Bash glob compatibility; used by Jest, Rollup, chokidar; 5M+ dependents |

### Supporting
| Library | Version | Purpose | When to Use |
|---------|---------|---------|-------------|
| `toml` | 3.0.0 | Parse task.toml permission overrides | Already installed; used by evalRunner for task config |
| `fs-extra` | 11.3.3 | File operations for tool implementations | Already installed; provides `pathExists`, `readFile`, `writeFile`, `ensureDir` |

### Alternatives Considered
| Instead of | Could Use | Tradeoff |
|------------|-----------|----------|
| `ollama` npm | Raw `fetch` to `/api/chat` | Raw fetch works but loses TypeScript types for `Tool`, `ChatResponse`, `ToolCall`; existing grader code uses raw fetch but agent loop benefits from typed iteration |
| `picomatch` | `minimatch` | picomatch is 2-3x faster with identical glob semantics; minimatch is heavier with more npm baggage |
| `picomatch` | Simple string matching | Permission globs like `bash(rm -rf *)` need real glob expansion; hand-rolling is error-prone |

**Installation:**
```bash
npm install ollama picomatch
npm install -D @types/picomatch
```

## Architecture Patterns

### Recommended Project Structure
```
src/
  agents/
    ollama/
      index.ts            # OllamaToolAgent class (extends BaseAgent)
      tools.ts            # Tool definitions and executors
      permissions.ts      # Three-tier permission system
      types.ts            # Ollama-specific type extensions
      smoke-test.ts       # Pre-eval tool-calling gate
    gemini.ts             # Existing (unchanged)
    claude.ts             # Existing (unchanged)
  cli.ts                  # Add --agent=ollama case
  types.ts                # Existing (unchanged)
modelfiles/
  qwen3-agent.Modelfile   # Custom Modelfile for agent model
```

### Pattern 1: Tool-Calling Agent Loop
**What:** Iterative loop that sends messages to Ollama, checks for `tool_calls` in response, executes tools, sends results back as `tool` role messages, and repeats until the model responds with content (no tool calls) or max iterations reached.
**When to use:** Every OllamaToolAgent `run()` invocation.
**Example:**
```typescript
// Source: https://docs.ollama.com/capabilities/tool-calling
import { Ollama, ChatResponse, Tool, Message } from 'ollama';

const ollama = new Ollama({ host: 'http://localhost:11434' });

async function agentLoop(
  model: string,
  systemPrompt: string,
  instruction: string,
  tools: Tool[],
  executeTool: (name: string, args: Record<string, unknown>) => Promise<string>,
  maxIterations: number = 30
): Promise<string> {
  const messages: Message[] = [
    { role: 'system', content: systemPrompt },
    { role: 'user', content: instruction },
  ];

  for (let i = 0; i < maxIterations; i++) {
    const response: ChatResponse = await ollama.chat({
      model,
      messages,
      tools,
      stream: false,
      think: false,  // Disable thinking for deterministic tool calling
    });

    // If no tool calls, model is done -- return final content
    if (!response.message.tool_calls?.length) {
      return response.message.content;
    }

    // Push assistant message with tool_calls to history
    messages.push(response.message);

    // Execute each tool call and push results
    for (const toolCall of response.message.tool_calls) {
      const result = await executeTool(
        toolCall.function.name,
        toolCall.function.arguments
      );

      messages.push({
        role: 'tool',
        content: result,
      });
    }
  }

  return '[Agent reached max iterations]';
}
```

### Pattern 2: Tool Definition Schema
**What:** JSON Schema tool definitions passed to Ollama's `tools` parameter.
**When to use:** Defining the four agent tools.
**Example:**
```typescript
// Source: https://docs.ollama.com/capabilities/tool-calling
const tools: Tool[] = [
  {
    type: 'function',
    function: {
      name: 'read_file',
      description: 'Read the contents of a file at the given path relative to the workspace root.',
      parameters: {
        type: 'object',
        required: ['path'],
        properties: {
          path: { type: 'string', description: 'File path relative to workspace root' },
          offset: { type: 'number', description: 'Line number to start reading from (1-based)' },
          limit: { type: 'number', description: 'Maximum number of lines to read' },
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'write_file',
      description: 'Write content to a file at the given path relative to the workspace root.',
      parameters: {
        type: 'object',
        required: ['path', 'content'],
        properties: {
          path: { type: 'string', description: 'File path relative to workspace root' },
          content: { type: 'string', description: 'Content to write to the file' },
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'bash',
      description: 'Run a bash command in the workspace directory.',
      parameters: {
        type: 'object',
        required: ['command'],
        properties: {
          command: { type: 'string', description: 'The bash command to execute' },
          timeout: { type: 'number', description: 'Timeout in seconds (default: 60)' },
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'list_directory',
      description: 'List files and directories at the given path relative to the workspace root.',
      parameters: {
        type: 'object',
        required: ['path'],
        properties: {
          path: { type: 'string', description: 'Directory path relative to workspace root (use "." for root)' },
        },
      },
    },
  },
];
```

### Pattern 3: Path Traversal Defense
**What:** Resolve tool file paths against workspace root and reject any path that escapes the boundary.
**When to use:** Every `read_file`, `write_file`, `list_directory` invocation.
**Example:**
```typescript
import * as path from 'path';

function resolveWorkspacePath(workspaceRoot: string, relativePath: string): string {
  const resolved = path.resolve(workspaceRoot, relativePath);
  const normalized = path.normalize(resolved);

  if (!normalized.startsWith(path.normalize(workspaceRoot) + path.sep) &&
      normalized !== path.normalize(workspaceRoot)) {
    throw new Error(`Path traversal blocked: "${relativePath}" resolves outside workspace`);
  }

  return normalized;
}
```

### Pattern 4: Three-Tier Permission Check
**What:** Check bash commands against hardcoded denylist, agent defaults, and task.toml overrides using glob matching.
**When to use:** Before every `bash` tool execution.
**Example:**
```typescript
import picomatch from 'picomatch';

// Tier 1: Hardcoded secure denylist (immutable)
const SECURE_DENYLIST: string[] = [
  'rm -rf /*',
  'rm -rf /',
  'rm -fr /*',
  'rm -fr /',
  'mkfs*',
  'dd if=*of=/dev/*',
  ':(){:|:&};:',         // fork bomb
  'chmod -R 777 /*',
  'wget * | bash',
  'curl * | bash',
  'curl * | sh',
  'wget * | sh',
  'shutdown*',
  'reboot*',
  'halt*',
  'poweroff*',
  'init 0',
  'init 6',
  'kill -9 -1',
  'killall -9 *',
  'pkill -9 *',
  '> /dev/sda',
  'mv /* /dev/null',
  'sudo su*',
  'sudo -i*',
  'sudo bash*',
  'sudo sh*',
];

function isCommandAllowed(
  command: string,
  secureDenylist: string[],
  agentDenylist: string[],
  agentAllowlist: string[],
  taskDenylist: string[],
  taskAllowlist: string[],
): boolean {
  // Tier 1: Hardcoded secure denylist -- NEVER override
  for (const pattern of secureDenylist) {
    if (picomatch.isMatch(command, pattern)) {
      return false;
    }
  }

  // Tier 2+3: Merge agent defaults with task overrides
  const effectiveDenylist = [...agentDenylist, ...taskDenylist];
  const effectiveAllowlist = [...agentAllowlist, ...taskAllowlist];

  // Check deny first
  for (const pattern of effectiveDenylist) {
    if (picomatch.isMatch(command, pattern)) {
      return false;
    }
  }

  // If allowlist is non-empty, command must match at least one pattern
  if (effectiveAllowlist.length > 0) {
    return effectiveAllowlist.some(pattern => picomatch.isMatch(command, pattern));
  }

  return true; // Default allow if no allowlist specified
}
```

### Pattern 5: Model Unloading for Sequential Loading
**What:** Explicitly unload the agent model after the agent run completes, before the grader loads its model.
**When to use:** After `OllamaToolAgent.run()` returns, before grading begins.
**Example:**
```typescript
// Source: https://docs.ollama.com/faq
import { Ollama } from 'ollama';

const ollama = new Ollama({ host: 'http://localhost:11434' });

async function unloadModel(model: string): Promise<void> {
  await ollama.chat({
    model,
    messages: [],
    keep_alive: 0,
  });
}
```

### Anti-Patterns to Avoid
- **Relying on Ollama's default context window:** Ollama defaults to 2,048 tokens (not 4K as sometimes stated). This silently truncates conversation history, causing the model to "forget" earlier tool results and loop or hallucinate. Always set `num_ctx` via Modelfile or API `options`.
- **Using thinking mode with tool calling:** Qwen3's thinking mode (`<think>` blocks) adds latency and can interfere with structured tool call output. Disable via `think: false` in API calls.
- **Parsing tool calls from text content:** When the model supports native tool calling, never regex-parse tool calls from `content` -- use the structured `tool_calls` array. Only fall back to text parsing if the smoke test reveals the model emits tool calls as text.
- **Leaving models loaded during grading:** On 16GB RAM, the 8B agent model (~5-6GB) plus the 3B grader model (~2-3GB) can coexist, but the KV cache for agentic context (16K tokens) can push total usage over 16GB. Always unload first.

## Don't Hand-Roll

| Problem | Don't Build | Use Instead | Why |
|---------|-------------|-------------|-----|
| Ollama API client | Custom fetch wrapper with types | `ollama` npm package (v0.6.3) | Handles streaming, tool calls, abort signals, retry; typed `ChatResponse`, `Tool`, `Message` interfaces |
| Glob pattern matching | Regex-based command matching | `picomatch` (v4.0.3) | Bash glob semantics are subtle (extglobs, braces, brackets); picomatch is battle-tested across 5M+ projects |
| Tool call JSON parsing | Manual JSON extraction from text | Ollama's native `tool_calls` array | Structured output is already parsed by the API; text fallback is a separate concern |
| Path normalization | String manipulation for path safety | `path.resolve()` + `path.normalize()` + startsWith check | Node.js path module handles all edge cases (`..\..`, symlinks, mixed separators) |

**Key insight:** The `ollama` npm package eliminates most of the boilerplate that the existing `LLMGrader` code handles manually (raw fetch, JSON parsing, timeout signals). The agent loop is the novel part; everything else has a library.

## Common Pitfalls

### Pitfall 1: Ollama Default Context Window is 2,048 Tokens
**What goes wrong:** Without a custom Modelfile or `num_ctx` API option, Ollama uses only 2,048 tokens of context. In multi-turn tool calling loops, earlier messages are silently truncated, causing the model to repeat tool calls or lose track of the task.
**Why it happens:** Ollama's default `num_ctx` was reduced from 4096 to 2048 in recent versions for memory efficiency. The Qwen3 team explicitly warns about this.
**How to avoid:** Create a custom Modelfile with `PARAMETER num_ctx 16384` and create the model with `ollama create`. Alternatively, pass `options: { num_ctx: 16384 }` on every API call (but Modelfile is preferred for consistency).
**Warning signs:** Agent loops that repeat the same tool call, or agent output that seems to "forget" earlier context.

### Pitfall 2: Qwen3 Thinking Mode Interferes with Tool Calling
**What goes wrong:** Qwen3 models default to thinking mode, which wraps output in `<think>` blocks. This adds latency (extra token generation) and can produce tool calls embedded in thinking output rather than as structured `tool_calls`.
**Why it happens:** Thinking mode is the default for Qwen3 series. Known issues exist where `/no_think` in-prompt tags do not reliably disable it.
**How to avoid:** Use the `think: false` API parameter (most reliable). Do NOT rely on `/no_think` in system prompts as it is known to be unreliable.
**Warning signs:** Slow first response, `<think>` blocks in content, tool calls appearing as text rather than structured output.

### Pitfall 3: Small Models Emit Tool Calls as Text
**What goes wrong:** Some 8B models emit tool call JSON as plain text in `content` rather than using the structured `tool_calls` response format. The agent loop sees no `tool_calls`, treats it as final output, and returns without completing the task.
**Why it happens:** Smaller models have weaker instruction following for structured output formats. The model "knows" about tools but formats the response as text.
**How to avoid:** The smoke test gate catches this before any eval trial starts. If detected, implement a text-to-tool-call fallback parser as a safety net, or switch to a fallback model.
**Warning signs:** Smoke test failure; `content` field containing JSON-like strings with function names.

### Pitfall 4: Model Unload Race Condition
**What goes wrong:** After calling `keep_alive: 0`, the model may not be fully unloaded before the grader starts loading its model. On 16GB RAM, both models plus KV caches can trigger OOM.
**Why it happens:** `keep_alive: 0` is a hint, not a synchronous guarantee. Ollama may take seconds to fully release memory.
**How to avoid:** After `keep_alive: 0`, poll `ollama ps` (via API `GET /api/ps`) to confirm the agent model is fully unloaded before proceeding to grading. Add a reasonable timeout (30s).
**Warning signs:** Grader hangs or crashes with OOM; `ollama ps` shows both models loaded.

### Pitfall 5: Path Traversal via Symlinks
**What goes wrong:** An agent could create a symlink inside the workspace that points outside it, then use `read_file` on the symlink to read arbitrary files.
**Why it happens:** `path.resolve()` does not follow symlinks by default, but `fs.readFile()` does.
**How to avoid:** Use `fs.realpath()` on the resolved path and verify the real path is still within the workspace boundary. Apply this check on both the input path and the `realpath` result.
**Warning signs:** `read_file` returning content from files outside the workspace.

### Pitfall 6: Conversation History Exceeds Context Window
**What goes wrong:** After many tool call iterations, the accumulated messages exceed `num_ctx`, causing Ollama to truncate from the beginning. The system prompt (with tool descriptions) gets truncated first, breaking tool calling entirely.
**Why it happens:** Each tool call + result adds messages. A 10-step agent loop with verbose tool output can easily exceed 16K tokens.
**How to avoid:** Implement conversation history management: truncate old tool results (keep summaries), or implement a sliding window that always preserves the system prompt and recent messages. Track estimated token count.
**Warning signs:** Tool calling stops working mid-loop; model starts generating generic text instead of tool calls.

## Code Examples

### Custom Modelfile for Agent Model
```dockerfile
# modelfiles/qwen3-agent.Modelfile
FROM qwen3:8b
PARAMETER num_ctx 16384
PARAMETER num_predict 4096
PARAMETER temperature 0
```

Build with:
```bash
ollama create qwen3-agent -f modelfiles/qwen3-agent.Modelfile
```

### Smoke Test Implementation
```typescript
// Source: project-specific pattern based on Ollama tool calling docs
async function smokeTestToolCalling(
  ollama: Ollama,
  model: string
): Promise<{ passed: boolean; error?: string }> {
  const testTool: Tool = {
    type: 'function',
    function: {
      name: 'list_directory',
      description: 'List files in a directory',
      parameters: {
        type: 'object',
        required: ['path'],
        properties: {
          path: { type: 'string', description: 'Directory path' },
        },
      },
    },
  };

  try {
    const response = await ollama.chat({
      model,
      messages: [
        { role: 'user', content: 'List the files in the current directory.' },
      ],
      tools: [testTool],
      stream: false,
      think: false,
      options: { num_ctx: 4096, num_predict: 256 },
    });

    if (response.message.tool_calls?.length) {
      const call = response.message.tool_calls[0];

      if (call.function.name === 'list_directory') {
        return { passed: true };
      }

      return {
        passed: false,
        error: `Expected list_directory call, got: ${call.function.name}`,
      };
    }

    // Check for text-based tool calls (fallback detection)
    const content = response.message.content;

    if (content.includes('list_directory') || content.includes('"name"')) {
      return {
        passed: false,
        error: `Model emits tool calls as text, not structured tool_calls: ${content.substring(0, 200)}`,
      };
    }

    return {
      passed: false,
      error: `No tool calls in response. Content: ${content.substring(0, 200)}`,
    };
  } catch (err: any) {
    return { passed: false, error: `Smoke test failed: ${err.message}` };
  }
}
```

### OllamaToolAgent Integration with Existing BaseAgent
```typescript
// src/agents/ollama/index.ts
import { BaseAgent, CommandResult } from '../../types';
import { Ollama, Tool, Message, ChatResponse } from 'ollama';

export class OllamaToolAgent extends BaseAgent {
  private ollama: Ollama;
  private model: string;
  private maxIterations: number;

  constructor(
    model: string = 'qwen3-agent',
    host: string = 'http://localhost:11434',
    maxIterations: number = 30
  ) {
    super();
    this.ollama = new Ollama({ host });
    this.model = model;
    this.maxIterations = maxIterations;
  }

  async run(
    instruction: string,
    workspacePath: string,
    runCommand: (cmd: string) => Promise<CommandResult>
  ): Promise<string> {
    // Tool-calling loop implementation
    // Uses runCommand for bash tool (delegates to provider)
    // Uses fs operations for file tools (path-scoped to workspacePath)
    // ...
    // After completion, unload model:
    await this.ollama.chat({
      model: this.model,
      messages: [],
      keep_alive: 0,
    });

    return finalOutput;
  }
}
```

### Tool Output Truncation
```typescript
const MAX_TOOL_OUTPUT_CHARS = 8000; // ~2000 tokens

function truncateToolOutput(output: string): string {
  if (output.length <= MAX_TOOL_OUTPUT_CHARS) {
    return output;
  }

  const half = Math.floor(MAX_TOOL_OUTPUT_CHARS / 2);

  return (
    output.substring(0, half) +
    `\n\n... [truncated ${output.length - MAX_TOOL_OUTPUT_CHARS} characters] ...\n\n` +
    output.substring(output.length - half)
  );
}
```

## Secure Bash Denylist Reference

Based on research across multiple sources (SafeExec, Claude Code sandboxing, NVIDIA guidance):

### Hardcoded Secure Denylist (Tier 1)
These patterns should be immutable and never overridable:

| Category | Patterns |
|----------|----------|
| Destructive filesystem | `rm -rf /`, `rm -rf /*`, `rm -fr /`, `rm -fr /*`, `mkfs*` |
| Disk/device operations | `dd if=*of=/dev/*`, `> /dev/sda*`, `mv /* /dev/null` |
| System control | `shutdown*`, `reboot*`, `halt*`, `poweroff*`, `init 0`, `init 6` |
| Process killing | `kill -9 -1`, `killall -9 *` |
| Privilege escalation | `sudo su*`, `sudo -i*`, `sudo bash*`, `sudo sh*`, `su -` |
| Remote code execution | `curl * | bash`, `curl * | sh`, `wget * | bash`, `wget * | sh` |
| Fork bomb | `:(){:|:&};:` |
| Permission destruction | `chmod -R 777 /*`, `chmod -R 777 /` |

### Agent Defaults (Tier 2)
Reasonable defaults that can be overridden by task.toml:

| Category | Default Deny | Rationale |
|----------|-------------|-----------|
| Git destructive | `git reset --hard*`, `git clean -f*`, `git push --force*` | Protect workspace git state |
| npm destructive | `npm audit fix --force*` | Can break dependencies |
| Network | `curl*`, `wget*` | Tasks should be offline-capable |

**Important caveat:** Glob-based denylists are bypassable in principle (bash quoting, absolute paths, shell variable expansion). The denylist is defense-in-depth within an already-sandboxed environment (LocalProvider temp dir or Docker container), NOT a security boundary. The real security boundary is the provider sandbox.

## Model Fallback Candidates

If `qwen3:8b` fails the smoke test:

| Model | Size | Tool Calling | Notes |
|-------|------|-------------|-------|
| `llama3.1:8b` | ~4.7GB | Supported via Ollama tool API | Well-tested for tool calling; less capable at complex reasoning than Qwen3 |
| `mistral-nemo:12b` | ~7.1GB | Supported via Ollama tool API | Better reasoning but larger; may be tight on 16GB with grader |
| `qwen2.5:7b` | ~4.7GB | Supported via Ollama tool API | Same family as existing grader model; known good Ollama integration |

## State of the Art

| Old Approach | Current Approach | When Changed | Impact |
|--------------|------------------|--------------|--------|
| Raw `/api/generate` | `/api/chat` with `tools` parameter | Ollama 0.3+ (2024) | Native structured tool calling instead of text-based parsing |
| Text-based tool parsing | Native `tool_calls` response array | Ollama tool support blog (2024) | Eliminates brittle regex parsing of model output |
| Default 4096 num_ctx | Default 2048 num_ctx | Recent Ollama versions | Must explicitly set context window for any multi-turn use |
| Manual JSON mode | Structured outputs with JSON Schema | Ollama structured outputs (2024) | Can constrain output format; useful for grading but agent uses tool_calls |
| Thinking always on | `think: true/false` API parameter | Ollama thinking support (2025) | Reliable toggle for Qwen3/DeepSeek thinking; prefer over in-prompt tags |

**Deprecated/outdated:**
- `/api/generate` for chat: Use `/api/chat` instead for multi-turn conversations with tool calling
- `format: "json"` for tool calling: Use the `tools` parameter instead; `format` is for constraining final text output
- In-prompt `/no_think` tags: Known to be unreliable; use `think: false` API parameter

## Open Questions

1. **Exact memory footprint of qwen3:8b with num_ctx 16384**
   - What we know: Base model ~5-6GB at Q4_K_M; 8192 context adds ~1GB VRAM
   - What's unclear: Exact memory at 16384 on Windows ARM64 with CPU inference (no discrete GPU)
   - Recommendation: Start with 16384, measure actual RSS. If OOM, drop to 8192. The superlint_demo task is simple enough that 8192 may suffice.

2. **Ollama `keep_alive: 0` reliability on Windows**
   - What we know: Works on Linux/macOS per docs; known bug with `keep_alive=-1` on Windows (issue #7773)
   - What's unclear: Whether `keep_alive: 0` has similar Windows-specific issues
   - Recommendation: Implement both `keep_alive: 0` and `ollama stop` fallback. Verify with `GET /api/ps` after unload.

3. **Tool response format for `bash` tool**
   - What we know: The provider's `runCommand` returns `CommandResult { stdout, stderr, exitCode }`
   - What's unclear: Best format for returning this to the model (structured JSON vs concatenated text)
   - Recommendation: Return as formatted text: `stdout:\n{stdout}\nstderr:\n{stderr}\nexit code: {exitCode}` -- models handle plain text better than nested JSON in tool responses.

## Validation Architecture

### Test Framework
| Property | Value |
|----------|-------|
| Framework | ts-node with manual test scripts (project convention) |
| Config file | none -- tests are standalone `ts-node` scripts |
| Quick run command | `npx ts-node tests/ollama-agent.test.ts` |
| Full suite command | `npm run test:ollama-agent` (to be created) |

### Phase Requirements -> Test Map
| Req ID | Behavior | Test Type | Automated Command | File Exists? |
|--------|----------|-----------|-------------------|-------------|
| AGENT-01 | OllamaToolAgent completes a tool-calling loop | integration | `npx ts-node tests/ollama-agent.test.ts` | No -- Wave 0 |
| OLCFG-01 | qwen3:8b (or fallback) produces structured tool_calls | smoke | `npx ts-node tests/ollama-smoke.test.ts` | No -- Wave 0 |
| OLCFG-02 | Custom Modelfile has num_ctx > 2048 | unit | `npx ts-node tests/modelfile-config.test.ts` | No -- Wave 0 |
| OLCFG-03 | Agent model unloaded after run (ollama ps shows empty) | integration | `npx ts-node tests/model-unload.test.ts` | No -- Wave 0 |
| PIPE-01 | --agent=ollama selects OllamaToolAgent | unit | `npx ts-node tests/cli-ollama-flag.test.ts` | No -- Wave 0 |
| PIPE-03 | Smoke test blocks eval when model fails tool calling | unit | `npx ts-node tests/smoke-gate.test.ts` | No -- Wave 0 |

### Sampling Rate
- **Per task commit:** `npx ts-node tests/ollama-smoke.test.ts` (fast, no full eval)
- **Per wave merge:** Full test suite (all tests above)
- **Phase gate:** Full suite green + `npm run eval -- superlint_demo --agent=ollama --provider=local --trials=1`

### Wave 0 Gaps
- [ ] `tests/ollama-agent.test.ts` -- integration test for OllamaToolAgent loop (requires running Ollama)
- [ ] `tests/ollama-smoke.test.ts` -- smoke test for tool calling (requires running Ollama)
- [ ] `tests/permissions.test.ts` -- unit test for three-tier permission system (no Ollama needed)
- [ ] `tests/path-traversal.test.ts` -- unit test for path-scoping defense (no Ollama needed)
- [ ] Add `test:ollama-agent` script to package.json

## Sources

### Primary (HIGH confidence)
- [Ollama Tool Calling Docs](https://docs.ollama.com/capabilities/tool-calling) - Tool calling API format, request/response schema, supported patterns
- [Ollama Modelfile Reference](https://docs.ollama.com/modelfile) - `PARAMETER num_ctx`, `FROM`, Modelfile creation
- [Ollama FAQ](https://docs.ollama.com/faq) - `keep_alive: 0` unloading, model memory management, `OLLAMA_MAX_LOADED_MODELS`
- [ollama npm package](https://www.npmjs.com/package/ollama) - v0.6.3, TypeScript types, `chat()` API with tools
- [Qwen3 GitHub](https://github.com/QwenLM/Qwen3) - Model capabilities, context window specs, recommended settings

### Secondary (MEDIUM confidence)
- [Ollama Context Length Docs](https://docs.ollama.com/context-length) - Default num_ctx values, VRAM impact calculations
- [picomatch GitHub](https://github.com/micromatch/picomatch) - v4.0.3, API, Bash glob compatibility
- [SafeExec GitHub](https://github.com/agentify-sh/safeexec) - Dangerous command patterns, denylist reference
- [Ollama Thinking Docs](https://docs.ollama.com/capabilities/thinking) - `think: false` API parameter

### Tertiary (LOW confidence)
- WebSearch results on qwen3:8b memory usage with specific num_ctx values -- exact numbers vary by quantization and platform
- WebSearch results on `keep_alive: 0` Windows reliability -- reported bugs but unclear current status

## Metadata

**Confidence breakdown:**
- Standard stack: HIGH - Official Ollama npm package and docs verified; picomatch is widely adopted
- Architecture: HIGH - Tool calling loop is well-documented by Ollama; existing codebase patterns clear
- Pitfalls: HIGH - Default context window issue documented by Qwen team and Ollama; thinking mode issues confirmed across multiple sources
- Permission system: MEDIUM - Pattern matching approach is sound but glob-based denylists have known limitations; defense-in-depth, not security boundary
- Memory management: MEDIUM - Exact 16GB footprint for qwen3:8b + 16K context on Windows ARM64 CPU needs empirical validation

**Research date:** 2026-03-10
**Valid until:** 2026-04-10 (30 days -- Ollama ecosystem is fast-moving but core API is stable)
