# Technology Stack

**Project:** local-skill-eval v2.0 -- opencode + Ollama Agent Backend
**Researched:** 2026-03-10
**Focus:** Stack additions for opencode CLI with Ollama backend, direct Ollama tool use fallback
**Scope:** Only NEW capabilities. Existing stack (TypeScript, Node.js 24+, Ollama qwen2.5:3b grader, GitHub Actions, Docker) is validated and NOT re-researched.

## Critical Finding: OpenCode Has No Windows ARM64 Support

**Confidence: HIGH** -- verified via GitHub issues [#4340](https://github.com/anomalyco/opencode/issues/4340), [#9232](https://github.com/anomalyco/opencode/issues/9232), [#9678](https://github.com/anomalyco/opencode/issues/9678), [#10302](https://github.com/anomalyco/opencode/issues/10302).

OpenCode ships binaries for linux-x64, linux-arm64, darwin-x64, darwin-arm64, and **windows-x64 only**. There is no `opencode-windows-arm64` package. On Windows ARM64 (Snapdragon X Elite):

- `npm install -g opencode-ai` fails with EBADPLATFORM because the arm64 binary does not exist.
- Manually extracting the x64 zip runs under Windows x86 emulation but has regressions: segfaults (v1.1.32), hangs (v1.1.15), and spawning failures.
- Multiple GitHub issues request ARM64 support; none have been resolved as of v1.2.23 (March 9, 2026).

**Impact on local development:** OpenCode is unreliable on the development machine (Surface Laptop 7, Snapdragon X Elite). May work intermittently via x86 emulation but cannot be depended on.

**Impact on CI:** The CI target is ubuntu-24.04-arm (ARM64 Linux), where opencode **does** ship a native arm64 binary. OpenCode will work reliably in CI.

**Recommendation:** Prioritize CI-first development. Test opencode integration in CI where ARM64 Linux is supported. For local development, use the direct Ollama tool use fallback path (which depends only on the `ollama` npm package and works everywhere).

## Recommended Stack Additions

### OpenCode CLI (Agent Backend)

| Technology | Version | Purpose | Why |
|------------|---------|---------|-----|
| **opencode** (CLI) | v1.2.23 | Agent CLI for agentic coding evaluation | Open-source coding agent (Go binary) with 45K+ GitHub stars. Supports Ollama via OpenAI-compatible endpoint. `opencode run` provides non-interactive mode for automation. Native ARM64 Linux binary for CI. |

**Install methods:**
```bash
# CI (ubuntu-24.04-arm) -- preferred
npm i -g opencode-ai@latest

# Alternative CI install
curl -fsSL https://opencode.ai/install | bash

# Local dev (Windows ARM64) -- UNRELIABLE, use at own risk
# Scoop may work better than npm: scoop install opencode
# Or manually extract opencode-windows-x64.zip from GitHub releases
```

**Non-interactive execution:**
```bash
# Basic non-interactive run (auto-approves all permissions)
opencode run "Apply the superlint skill to fix linting issues" --format json --quiet

# With model override
opencode run "..." --model ollama/qwen3:8b --format json --quiet

# Attach to running server (avoids MCP cold boot per run)
opencode run "..." --attach --port 3000
```

**Key flags for eval integration:**
- `--format json` -- structured JSON event output for parsing
- `--quiet` / `-q` -- suppress spinner animation (critical for piped output)
- `--model provider/model` -- override model selection
- `--continue` / `-c` -- resume previous session
- No formal `--non-interactive` flag exists yet (open issue [#10411](https://github.com/anomalyco/opencode/issues/10411)); `opencode run` with a prompt argument is the current workaround

**Known issue:** `opencode run` can hang in CI waiting for input that never comes (issue [#5888](https://github.com/anomalyco/opencode/issues/5888)). Mitigate by always providing the full prompt as a CLI argument and using `--quiet`.

### OpenCode Ollama Configuration

**Config file:** `~/.config/opencode/opencode.json` (or project-local `opencode.json`)

```json
{
  "$schema": "https://opencode.ai/config.json",
  "provider": {
    "ollama": {
      "npm": "@ai-sdk/openai-compatible",
      "name": "Ollama (local)",
      "options": {
        "baseURL": "http://localhost:11434/v1"
      },
      "models": {
        "qwen3:8b": {
          "name": "Qwen3 8B",
          "limit": {
            "context": 16384,
            "output": 4096
          }
        }
      }
    }
  }
}
```

**Alternative setup via `ollama launch`** (Ollama v0.15+):
```bash
ollama launch opencode --model qwen3:8b
# or config-only mode (writes config without launching)
ollama launch opencode --config
```

**Context window warning:** Ollama defaults to 4096 tokens. OpenCode recommends 64K+ for effective operation. For 16GB RAM targets, 16K-32K is the practical maximum. If tool calls fail, increase `num_ctx`.

**Confidence: HIGH** -- verified via [opencode.ai/docs/providers](https://opencode.ai/docs/providers/), [docs.ollama.com/integrations/opencode](https://docs.ollama.com/integrations/opencode), community guides.

### Direct Ollama Tool Use (Fallback Path)

| Technology | Version | Purpose | Why |
|------------|---------|---------|-----|
| **ollama** (npm) | 0.6.3 | Node.js client for Ollama chat API with tool calling | Already a dependency for grading. Tool calling via `tools` parameter in `chat()`. Avoids external CLI dependency entirely. TypeScript types included. Works everywhere Ollama runs. |

**Confidence: HIGH** -- already validated in v1.0 for grading. Tool calling is a documented API feature.

**Tool calling pattern:**
```typescript
import { Ollama } from 'ollama';

const ollama = new Ollama({ host: 'http://localhost:11434' });

// Define tools the agent can use
const tools = [
  {
    type: 'function' as const,
    function: {
      name: 'write_file',
      description: 'Write content to a file',
      parameters: {
        type: 'object',
        required: ['path', 'content'],
        properties: {
          path: { type: 'string', description: 'File path' },
          content: { type: 'string', description: 'File content' },
        },
      },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'run_command',
      description: 'Execute a shell command',
      parameters: {
        type: 'object',
        required: ['command'],
        properties: {
          command: { type: 'string', description: 'Shell command to execute' },
        },
      },
    },
  },
];

// Agent loop
const messages = [{ role: 'user' as const, content: instruction }];

while (true) {
  const response = await ollama.chat({
    model: 'qwen3:8b',
    messages,
    tools,
    options: { num_ctx: 16384, temperature: 0 },
  });

  if (!response.message.tool_calls?.length) {
    break; // No more tool calls -- agent is done
  }

  // Execute tool calls
  messages.push(response.message);

  for (const call of response.message.tool_calls) {
    const result = await executeToolCall(call.function.name, call.function.arguments);
    messages.push({
      role: 'tool' as const,
      content: JSON.stringify(result),
    });
  }
}
```

**Why this is the fallback, not the primary path:** OpenCode provides a full agent scaffold (file editing, code search, LSP integration, session management) that would take significant effort to replicate. The direct Ollama path only makes sense if opencode+Ollama proves unworkable for the eval use case.

### Ollama Models for Agent Tasks (Tool Calling)

**Constraint reminder:** 16 GB RAM on both local machine (usable) and CI runner. Model + KV cache + Node.js + Docker overhead must fit.

| Model | Total Params | Active Params | Size (Q4_K_M) | RAM with 16K ctx | Tool Calling | Recommendation |
|-------|-------------|---------------|---------------|------------------|-------------|----------------|
| **qwen3:8b** | 8B | 8B (dense) | 5.2 GB | ~8 GB | Yes -- trained with tool tokens | **Primary choice.** Best fit for 16 GB constraint. Matches qwen2.5-14b quality per Alibaba benchmarks. Thinking + non-thinking modes. |
| **qwen3-coder:30b-a3b** | 30B | 3.3B (MoE) | ~18.6 GB | ~22 GB | Yes -- specialized parser | **Does NOT fit.** Weights alone exceed 16 GB. Requires 20-24 GB minimum. Out of scope for CI runner. |
| **qwen3:4b** | 4B | 4B (dense) | ~2.7 GB | ~4.5 GB | Yes -- but less reliable | **Fallback for testing.** Rivals qwen2.5-7b quality. Very fast on CPU. Good for rapid iteration. |
| **qwen2.5-coder:7b** | 7B | 7B (dense) | ~4.7 GB | ~7 GB | Yes | **Alternative.** Strong code-specific training. 128K context support. Already familiar from v1.0 research. |
| **llama3.1:8b** | 8B | 8B (dense) | ~4.9 GB | ~7.5 GB | Yes | **Alternative.** Meta's model with good tool use. Less coding-focused than Qwen. |

**Model recommendation: qwen3:8b (Q4_K_M)** because:
1. Fits in 16 GB with 16K context (~8 GB total), leaving room for Node.js, Docker, and overhead
2. Tool calling trained natively (not bolted on)
3. Agent capabilities verified by Alibaba (tool integration in both thinking and non-thinking modes)
4. Performance matches qwen2.5-14b (the model we'd ideally use if RAM allowed)
5. Available directly from Ollama registry: `ollama pull qwen3:8b`

**Context window setup for agent use:**
```bash
# Create a variant with 16K context (saves as a new model tag)
ollama run qwen3:8b
>>> /set parameter num_ctx 16384
>>> /save qwen3:8b-16k
>>> /bye

# Or via Modelfile
echo 'FROM qwen3:8b
PARAMETER num_ctx 16384' > Modelfile
ollama create qwen3:8b-16k -f Modelfile
```

**Why NOT 64K context:** At 64K, the KV cache alone would consume ~8-10 GB for an 8B model, pushing total RAM to 15+ GB. Combined with Node.js and Docker overhead, this exceeds the 16 GB limit. Start with 16K and increase only if agent task completion requires more context.

**Confidence: HIGH for qwen3:8b fitting in 16 GB.** RAM estimates verified via [Ollama VRAM guide](https://localllm.in/blog/ollama-vram-requirements-for-local-llms), [Qwen3 specs](https://apxml.com/models/qwen3-8b), and community reports.

**Confidence: MEDIUM for tool calling quality at 8B scale.** Community consensus is that models under 14B have less reliable tool calling. The 8B model will work but may need prompt engineering to avoid hallucinated tool calls. The thinking mode in Qwen3 helps with reasoning about when to call tools.

### Integration with Existing Eval Runner

The existing agent pattern (from `BaseAgent`):

```typescript
// src/agents/gemini.ts pattern -- same interface for opencode
export class OpenCodeAgent extends BaseAgent {
    async run(
        instruction: string,
        _workspacePath: string,
        runCommand: (cmd: string) => Promise<CommandResult>
    ): Promise<string> {
        const b64 = Buffer.from(instruction).toString('base64');
        await runCommand(`echo '${b64}' | base64 -d > /tmp/.prompt.md`);

        const command = `opencode run "$(cat /tmp/.prompt.md)" --format json --quiet`;
        const result = await runCommand(command);

        if (result.exitCode !== 0) {
            console.error('OpenCodeAgent: opencode CLI failed to execute correctly.');
        }

        return result.stdout + '\n' + result.stderr;
    }
}
```

For the direct Ollama fallback, the agent would NOT use `runCommand` to shell out. Instead it would use the `ollama` npm client directly with a tool-calling loop, executing tool calls via the existing `runCommand` function:

```typescript
export class OllamaAgent extends BaseAgent {
    async run(
        instruction: string,
        workspacePath: string,
        runCommand: (cmd: string) => Promise<CommandResult>
    ): Promise<string> {
        const ollama = new Ollama({ host: 'http://localhost:11434' });
        // ... tool-calling loop using ollama.chat() with tools
        // Execute file operations and commands via runCommand()
        // Return transcript of all actions taken
    }
}
```

**What NOT to change:**
- Do NOT replace the existing `LLMGrader` or its qwen2.5:3b model -- it's validated and working
- Do NOT change `BaseAgent` interface -- new agents implement the same `run()` contract
- Do NOT add `ollama` as a new dependency -- it should already be added for the grader (if not yet, add it)
- Do NOT run agent and grader models simultaneously -- sequential execution is required (16 GB constraint)

## Existing Stack (Validated, Not Changed)

These are documented for completeness. They were researched in v1.0 and remain unchanged.

| Technology | Version | Purpose | Status |
|------------|---------|---------|--------|
| TypeScript | 5.9+ | Language | Validated |
| Node.js | 24+ | Runtime | Validated |
| Ollama server | v0.17+ | LLM inference server | Validated |
| qwen2.5:3b | Q4_K_M | Grader model | Validated -- perfect discrimination |
| GitHub Actions | ubuntu-24.04-arm | CI runner | Validated |
| Docker | latest | Task isolation | Validated |
| `dockerode` | 4.0.9 | Docker API client | Validated |
| `toml` | 3.0.0 | Config parsing | Validated |

## New Dependencies Summary

```bash
# Runtime dependency (if not already added)
npm install ollama@0.6.3

# Global CLI (CI only -- unreliable on Windows ARM64)
npm i -g opencode-ai@latest

# Ollama models to pull
ollama pull qwen3:8b           # 5.2 GB -- agent model for opencode + direct tool use
# qwen2.5:3b already pulled    # grader model (existing)
```

**Total new npm dependencies:** 1 package (`ollama` -- may already be present)
**Total new global CLIs:** 1 (`opencode-ai` -- CI only)
**Total new Ollama models:** 1 (`qwen3:8b` -- 5.2 GB download)

## Alternatives Considered

| Category | Recommended | Alternative | Why Not |
|----------|-------------|-------------|---------|
| Agent model | qwen3:8b (5.2 GB) | qwen3-coder:30b-a3b (18.6 GB) | Does not fit in 16 GB RAM. Weights alone exceed the limit. |
| Agent model | qwen3:8b (5.2 GB) | qwen2.5-coder:14b (9 GB) | Fits locally (32 GB) but risky on CI (16 GB) with 16K context (~12 GB total). qwen3:8b matches qwen2.5-14b quality at half the RAM. |
| Agent CLI | opencode | Claude Code with Ollama | Claude Code + Ollama requires Anthropic-compatible API (v0.14+). This works but Claude Code's Windows ARM64 support has its own issues. Defer to after opencode path is proven. |
| Direct tool use | ollama npm client | LangChain.js + @langchain/ollama | Adds heavy framework dependency. The ollama npm client's `chat()` with `tools` parameter does everything needed. LangChain is overkill for a simple tool-calling loop. |
| Direct tool use | ollama npm client | Vercel AI SDK + ai-sdk-ollama | Requires AI SDK v6 dependency chain. Over-engineered for calling one Ollama model with tools. |
| Agent scaffold | opencode | Building from scratch | OpenCode provides file editing, code search, LSP, session management. Replicating this for the eval framework would be months of work for marginal benefit. |
| Agent model context | 16K tokens | 64K tokens | KV cache at 64K would consume ~8-10 GB, pushing total past 16 GB. Start small, increase if needed. |

## Version Compatibility Matrix

| Component A | Component B | Compatibility | Notes |
|-------------|-------------|---------------|-------|
| opencode v1.2.23 | Ollama v0.17+ | Via OpenAI-compatible /v1 endpoint | opencode uses @ai-sdk/openai-compatible internally |
| opencode v1.2.23 | ubuntu-24.04-arm (CI) | Native arm64 binary | Works reliably |
| opencode v1.2.23 | Windows 11 ARM64 | **NOT SUPPORTED** | No arm64 binary; x86 emulation has regressions |
| ollama npm 0.6.3 | Ollama server v0.17+ | Full compatibility | Tool calling, structured output, streaming all supported |
| ollama npm 0.6.3 | Node.js 24+ | Full compatibility | Uses native fetch, TypeScript types included |
| qwen3:8b | Ollama tool calling | Supported | Trained with tool-specific tokens |
| qwen3:8b | opencode | Supported | Via OpenAI-compatible endpoint |

## Sources

- [OpenCode docs: CLI](https://opencode.ai/docs/cli/) -- run command syntax, flags, non-interactive mode
- [OpenCode docs: Providers](https://opencode.ai/docs/providers/) -- Ollama configuration format
- [OpenCode GitHub releases](https://github.com/anomalyco/opencode/releases) -- v1.2.23 latest
- [OpenCode ARM64 issue #4340](https://github.com/anomalyco/opencode/issues/4340) -- Windows ARM64 not supported
- [OpenCode ARM64 issue #9678](https://github.com/anomalyco/opencode/issues/9678) -- Stopped working on ARM64
- [OpenCode ARM64 issue #10302](https://github.com/anomalyco/opencode/issues/10302) -- Segfault on ARM64
- [OpenCode non-interactive issue #10411](https://github.com/anomalyco/opencode/issues/10411) -- --non-interactive flag request
- [Ollama docs: tool calling](https://docs.ollama.com/capabilities/tool-calling) -- Tool API reference
- [Ollama docs: OpenCode integration](https://docs.ollama.com/integrations/opencode) -- Configuration guide
- [Ollama blog: launch command](https://ollama.com/blog/launch) -- v0.15 ollama launch
- [ollama/ollama-js GitHub](https://github.com/ollama/ollama-js) -- Official JS client
- [ollama npm registry](https://www.npmjs.com/package/ollama) -- v0.6.3 latest
- [Ollama VRAM requirements guide](https://localllm.in/blog/ollama-vram-requirements-for-local-llms) -- RAM estimation
- [Qwen3 8B specs](https://apxml.com/models/qwen3-8b) -- Model parameters and memory
- [Qwen3 official GitHub](https://github.com/QwenLM/Qwen3) -- Model capabilities, tool calling
- [Qwen3 blog post](https://qwenlm.github.io/blog/qwen3/) -- Benchmark results, architecture
- [Qwen3-Coder GitHub](https://github.com/QwenLM/Qwen3-Coder) -- Coder variant specs
- [Ollama qwen3:8b model page](https://ollama.com/library/qwen3:8b) -- Download size, tags
- [ollama-x-opencode setup guide](https://github.com/p-lemonish/ollama-x-opencode) -- Community integration guide
- [Best Ollama models for tool calling 2026](https://clawdbook.org/blog/openclaw-best-ollama-models-2026) -- Model comparison
- [Red Hat: Node.js Ollama tool use](https://developers.redhat.com/blog/2024/09/10/quick-look-tool-usefunction-calling-nodejs-and-ollama) -- Tool calling pattern

---
*Stack research for: opencode CLI + Ollama agent backend additions to local-skill-eval v2.0*
*Researched: 2026-03-10*
