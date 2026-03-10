# Architecture Patterns: opencode + Ollama Agent Backend

**Domain:** Local LLM agent evaluation -- opencode CLI integration with existing eval runner
**Researched:** 2026-03-10
**Milestone:** v2.0 opencode + Ollama

## Executive Summary

The existing eval runner architecture (EvalRunner -> Agents -> Providers -> Graders) supports agent integration cleanly through the `BaseAgent` abstract class and `EnvironmentProvider` interface. Adding opencode as an agent backend requires: (1) a new `OpenCodeAgent` class in `src/agents/`, (2) opencode configuration injection into the workspace before agent execution, (3) a new `--agent=opencode` CLI flag, and (4) task.toml extensions for agent backend configuration.

**Critical platform constraint discovered:** opencode does not ship a Windows ARM64 binary (blocked by upstream Bun dependency, GitHub issue #4340). The linux-arm64 binary also has a known SIGABRT crash on Ubuntu 24.04 with certain kernel configurations (GitHub issue #13367). This means opencode integration must be validated on both the local development machine (Windows ARM64) and CI runners (ubuntu-24.04-arm) before committing to the opencode path. The fallback -- direct Ollama tool-use agent -- becomes a realistic primary path rather than a mere backup.

## Recommended Architecture

### What Changes vs What Stays

**UNCHANGED (existing components):**
- `EvalRunner` class and its trial loop (no modifications needed)
- `EnvironmentProvider` interface and both `DockerProvider`/`LocalProvider` implementations
- `DeterministicGrader` and `LLMGrader` (already has Ollama support for grading)
- CLI argument parsing structure (just needs a new agent option)
- Report format, analytics, and reporters
- GitHub Actions workflow structure (setup-node, setup-ollama composite actions)

**NEW components:**
- `src/agents/opencode.ts` -- `OpenCodeAgent` extending `BaseAgent`
- `src/agents/ollama.ts` -- `OllamaToolAgent` extending `BaseAgent` (fallback)
- `src/agents/config.ts` -- Agent configuration writer (generates opencode.json per workspace)
- Ollama agent model warmup logic (reuse pattern from LLMGrader.warmUp)

**MODIFIED components:**
- `src/cli.ts` -- Add `--agent=opencode` and `--agent=ollama` to agent selection
- `src/types.ts` -- Extend `TaskConfig` with optional `[agent.backend]` section
- `src/providers/local.ts` -- Add opencode skill injection path (`.opencode/skills/`)
- `src/providers/docker.ts` -- Add opencode skill injection path
- `tasks/superlint_demo/task.toml` -- Add agent backend configuration

### High-Level Component Diagram

```
+------------------+     +---------------------+     +-------------------+
|                  |     |                     |     |                   |
|  CLI Layer       |---->|  EvalRunner         |---->|  Reporters /      |
|  (src/cli.ts)    |     |  (Orchestration)    |     |  Analytics        |
|                  |     |    [UNCHANGED]       |     |    [UNCHANGED]    |
+------------------+     +----------+----------+     +-------------------+
                                    |
                    +---------------+---------------+
                    |               |               |
            +-------v------+ +-----v------+ +------v-------+
            |              | |            | |              |
            |  Agents      | | Providers  | |  Graders     |
            |  [MODIFIED]  | | [MODIFIED] | |  [UNCHANGED] |
            |              | |            | |              |
            |  gemini  (v1)| | docker (v1)| |  determin.   |
            |  claude  (v1)| | local  (v1)| |  llm_rubric  |
            |  opencode[v2]| |            | |              |
            |  ollama  [v2]| |            | |              |
            +-+----+-------+ +------------+ +------+-------+
              |    |                               |
              |    +---------- [Agent Model] ------+-- [Grader Model]
              |                     |              |
      +-------v---------------------v--------------v-------+
      |                                                     |
      |           Ollama Server (localhost:11434)            |
      |           [EXISTING -- already used by LLMGrader]   |
      |                                                     |
      |  /v1/chat/completions  <-- opencode, OllamaToolAgent|
      |  /api/chat             <-- OllamaToolAgent (native) |
      |  /api/generate         <-- LLMGrader (existing)     |
      |                                                     |
      +-----------------------------------------------------+
```

### Component Boundaries

| Component | Responsibility | New/Modified | Communicates With |
|-----------|---------------|--------------|-------------------|
| `OpenCodeAgent` | Invoke opencode CLI in non-interactive mode inside workspace | **NEW** | Provider.runCommand(), Ollama (indirect via opencode config) |
| `OllamaToolAgent` | Direct Ollama tool-calling agent loop -- read/write/exec tools | **NEW** | Ollama /api/chat (native API), workspace filesystem |
| Agent config writer | Generate opencode.json with Ollama provider config per workspace | **NEW** | Provider.runCommand() to write config files |
| CLI (agent selection) | Add opencode and ollama agent types | **MODIFIED** | OpenCodeAgent, OllamaToolAgent constructors |
| LocalProvider (skill injection) | Add `.opencode/` skill discovery path | **MODIFIED** | Filesystem |
| DockerProvider (skill injection) | Add `.opencode/skills/` discovery path inside container | **MODIFIED** | Docker API |
| task.toml schema | Add `[agent.backend]` section for model/provider config | **MODIFIED** | loadTaskConfig() parser |

## Data Flow

### Primary Path: opencode Agent

```
1. CLI parses --agent=opencode --provider=local
      |
2. CLI reads task.toml [agent.backend] section:
   |  model = "ollama/qwen3:8b-32k"
   |  timeout_sec = 900
      |
3. Ollama health check: GET http://localhost:11434/
   Model check: GET /api/tags -> verify qwen3:8b-32k exists
      |
4. Provider.setup() creates workspace:
   a. Copy task files to temp dir
   b. Inject skills into .agents/skills/, .claude/skills/,
      AND .opencode/skills/ (NEW)
   c. Write opencode.json to workspace root (NEW):
      {
        "model": "ollama/qwen3:8b-32k",
        "provider": {
          "ollama": {
            "npm": "@ai-sdk/openai-compatible",
            "options": { "baseURL": "http://localhost:11434/v1" },
            "models": { "qwen3:8b-32k": { "name": "qwen3:8b-32k" } }
          }
        },
        "permission": { "edit": "allow", "bash": "allow" }
      }
      |
5. OpenCodeAgent.run(instruction, workspace, runCommand):
   a. Write instruction to /tmp/.prompt.md (existing b64 pattern)
   b. Run: opencode run "$(cat /tmp/.prompt.md)" -m ollama/qwen3:8b-32k
   c. opencode reads workspace opencode.json
   d. opencode -> Ollama /v1/chat/completions -> model inference
   e. opencode executes tool calls (file edits, bash commands)
   f. opencode writes results, exits
   g. Return stdout + stderr
      |
6. Graders score the workspace:
   a. DeterministicGrader: bash tests/test.sh -> exit code
   b. LLMGrader: POST transcript to Ollama /api/generate (EXISTING)
      -> uses qwen2.5:3b (different model than agent)
      |
7. EvalRunner calculates weighted reward, saves report
```

### Fallback Path: Direct Ollama Tool-Use Agent

If opencode is not installable on the target platform (Windows ARM64, or CI runner crash), use a custom agent that implements the tool-calling agent loop directly via Ollama's native API.

```
1. CLI parses --agent=ollama --provider=local
      |
2. OllamaToolAgent.run(instruction, workspace, runCommand):
   a. Define available tools as Ollama function schemas:
      - read_file(path) -> file contents
      - write_file(path, content) -> success
      - edit_file(path, old, new) -> success
      - bash(command) -> stdout + stderr + exit_code
      - list_directory(path) -> file listing
   b. Build initial messages: [{ role: "user", content: instruction }]
   c. Agent loop (while true):
      i.   POST /api/chat { model, messages, tools, think: true }
      ii.  If response.message.tool_calls is empty: break
      iii. For each tool_call:
           - Execute via runCommand() or filesystem API
           - Append { role: "tool", content: result } to messages
      iv.  Append assistant message to messages
      v.   Check iteration limit (max 50 turns) and timeout
   d. Return concatenated agent output
      |
3. Graders score as normal
```

### Agent Tool Schema (for OllamaToolAgent)

```typescript
const AGENT_TOOLS = [
  {
    type: 'function',
    function: {
      name: 'read_file',
      description: 'Read the contents of a file in the workspace',
      parameters: {
        type: 'object',
        required: ['path'],
        properties: {
          path: { type: 'string', description: 'Relative path from workspace root' }
        }
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'write_file',
      description: 'Write content to a file, creating it if needed',
      parameters: {
        type: 'object',
        required: ['path', 'content'],
        properties: {
          path: { type: 'string', description: 'Relative path from workspace root' },
          content: { type: 'string', description: 'File content to write' }
        }
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'bash',
      description: 'Execute a bash command in the workspace',
      parameters: {
        type: 'object',
        required: ['command'],
        properties: {
          command: { type: 'string', description: 'The bash command to run' }
        }
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'list_directory',
      description: 'List files and directories at a given path',
      parameters: {
        type: 'object',
        required: ['path'],
        properties: {
          path: { type: 'string', description: 'Relative directory path' }
        }
      }
    }
  }
];
```

### Memory Timeline for a Single Trial

```
Time -->
|===== Ollama serve (baseline ~200MB) =====================================|
|                                                                           |
|    Agent model loaded (~5-6 GB for 8B Q4, 32K ctx)                       |
|    |============================|                                        |
|    ^                            ^                                        |
|    opencode/ollama-agent start  Agent completes,                         |
|                                 model unloaded (keep_alive: 0)           |
|                                                                          |
|                                 Grader model loaded (~2 GB for 3B, 8K ctx)
|                                 |===========|                            |
|                                 ^           ^                            |
|                                 LLMGrader   Grader done,                 |
|                                 starts      model unloaded               |
|                                                                          |
|===== Node.js + Provider (~500MB) ========================================|
|===== OS + Docker (~2-3 GB) ==============================================|
```

Peak memory: ~8-9 GB (agent model + Node.js + OS). Fits in 16 GB with headroom.

## Patterns to Follow

### Pattern 1: OpenCodeAgent (Extends BaseAgent)

**What:** A new agent class that wraps the `opencode run` CLI command with Ollama backend configuration.
**When:** User passes `--agent=opencode` to the eval CLI.
**Why:** Follows the exact same pattern as `GeminiAgent` and `ClaudeAgent` -- write prompt to temp file, invoke CLI, return stdout/stderr.

```typescript
export class OpenCodeAgent extends BaseAgent {
    private model: string;

    constructor(model: string = 'ollama/qwen3:8b-32k') {
        super();
        this.model = model;
    }

    async run(
        instruction: string,
        _workspacePath: string,
        runCommand: (cmd: string) => Promise<CommandResult>
    ): Promise<string> {
        // Write instruction to temp file (same pattern as existing agents)
        const b64 = Buffer.from(instruction).toString('base64');
        await runCommand(`echo '${b64}' | base64 -d > /tmp/.prompt.md`);

        // Run opencode in non-interactive mode with model selection
        const command = `opencode run "$(cat /tmp/.prompt.md)" -m ${this.model}`;
        const result = await runCommand(command);

        if (result.exitCode !== 0) {
            console.error('OpenCodeAgent: opencode failed to execute correctly.');
        }

        return result.stdout + '\n' + result.stderr;
    }
}
```

### Pattern 2: Workspace Configuration Injection

**What:** Before running the agent, write configuration files into the workspace so the agent CLI discovers the correct LLM backend.
**When:** Setting up a workspace for an opencode agent run.
**Why:** opencode reads `opencode.json` from the project root. By placing it in the workspace (which is the cwd for the agent), it automatically discovers the Ollama backend without any global configuration.

```typescript
// In LocalProvider.setup() or as a pre-agent hook:
async function injectOpenCodeConfig(
    workspacePath: string,
    model: string,
    ollamaHost: string = 'http://localhost:11434'
): Promise<void> {
    const config = {
        "$schema": "https://opencode.ai/config.json",
        model: `ollama/${model}`,
        provider: {
            ollama: {
                npm: "@ai-sdk/openai-compatible",
                name: "Ollama",
                options: { baseURL: `${ollamaHost}/v1` },
                models: {
                    [model]: { name: model }
                }
            }
        },
        permission: {
            edit: "allow",
            bash: "allow"
        },
        autoupdate: false,
        enabled_providers: ["ollama"],
        disabled_providers: []
    };

    await fs.writeJSON(
        path.join(workspacePath, 'opencode.json'),
        config,
        { spaces: 2 }
    );
}
```

### Pattern 3: OllamaToolAgent (Direct Ollama Fallback)

**What:** A custom agent that implements its own tool-calling agent loop using Ollama's native `/api/chat` endpoint with tool definitions.
**When:** opencode is not available on the platform, or as the primary agent for maximum control.
**Why:** This avoids all external CLI dependencies. The eval runner already talks to Ollama for grading; extending this to agent execution is a natural progression. The `ollama` npm package provides TypeScript types and a clean API.

```typescript
import ollama from 'ollama';

export class OllamaToolAgent extends BaseAgent {
    private model: string;
    private maxTurns: number;

    constructor(model: string = 'qwen3:8b-32k', maxTurns: number = 50) {
        super();
        this.model = model;
        this.maxTurns = maxTurns;
    }

    async run(
        instruction: string,
        workspacePath: string,
        runCommand: (cmd: string) => Promise<CommandResult>
    ): Promise<string> {
        const messages = [{ role: 'user' as const, content: instruction }];
        const output: string[] = [];

        for (let turn = 0; turn < this.maxTurns; turn++) {
            const response = await ollama.chat({
                model: this.model,
                messages,
                tools: AGENT_TOOLS,
            });

            messages.push(response.message);

            if (response.message.content) {
                output.push(response.message.content);
            }

            const toolCalls = response.message.tool_calls ?? [];

            if (toolCalls.length === 0) {
                break;
            }

            for (const call of toolCalls) {
                const result = await this.executeTool(
                    call.function.name,
                    call.function.arguments,
                    workspacePath,
                    runCommand
                );
                messages.push({
                    role: 'tool' as const,
                    content: result
                });
            }
        }

        return output.join('\n');
    }

    private async executeTool(
        name: string,
        args: Record<string, any>,
        workspacePath: string,
        runCommand: (cmd: string) => Promise<CommandResult>
    ): Promise<string> {
        switch (name) {
            case 'bash': {
                const result = await runCommand(args.command);
                return `exit_code: ${result.exitCode}\nstdout: ${result.stdout}\nstderr: ${result.stderr}`;
            }
            case 'read_file': {
                const result = await runCommand(`cat "${args.path}"`);
                return result.exitCode === 0 ? result.stdout : `Error: ${result.stderr}`;
            }
            case 'write_file': {
                const b64 = Buffer.from(args.content).toString('base64');
                const result = await runCommand(
                    `echo '${b64}' | base64 -d > "${args.path}"`
                );
                return result.exitCode === 0 ? 'File written successfully' : `Error: ${result.stderr}`;
            }
            case 'list_directory': {
                const result = await runCommand(`ls -la "${args.path || '.'}"`);
                return result.stdout;
            }
            default:
                return `Unknown tool: ${name}`;
        }
    }
}
```

### Pattern 4: Task Config Extension for Agent Backend

**What:** Extend `task.toml` with an optional `[agent.backend]` section that specifies the model and provider for agent execution.
**When:** Running agent evaluations (not validation mode).
**Why:** Different tasks may need different agent models. A CPU-bound grading task may use a small 3B model for grading but a larger 8B model for agent work. Making this configurable per task avoids hardcoding.

```toml
version = "1.0"

[agent]
timeout_sec = 900.0

[agent.backend]
model = "qwen3:8b-32k"
provider = "ollama"
num_ctx = 32768

[environment]
build_timeout_sec = 180.0
cpus = 2
memory_mb = 2048
storage_mb = 500

[[graders]]
type = "deterministic"
command = "bash tests/test.sh"
weight = 0.7

[[graders]]
type = "llm_rubric"
rubric = "prompts/quality.md"
model = "qwen2.5:3b"
weight = 0.3
```

The TypeScript type change:

```typescript
// In src/types.ts - extend the existing TaskConfig
export interface AgentBackendConfig {
    model?: string;      // e.g., "qwen3:8b-32k"
    provider?: string;   // e.g., "ollama"
    num_ctx?: number;    // Context window override
}

export interface TaskConfig {
    // ... existing fields ...
    agent: {
        timeout_sec: number;
        backend?: AgentBackendConfig;  // NEW -- optional
    };
}
```

## Anti-Patterns to Avoid

### Anti-Pattern 1: Assuming opencode Works on All Platforms

**What:** Writing the architecture around opencode as the only agent path.
**Why bad:** opencode has no Windows ARM64 binary (GitHub #4340, blocked by Bun upstream). The linux-arm64 binary crashes on Ubuntu 24.04 (GitHub #13367, SIGABRT). Both target platforms (local dev machine and CI runner) are affected.
**Instead:** Build the `OllamaToolAgent` (direct tool-use) as a first-class path, not a fallback. Validate opencode installability before depending on it in CI.

### Anti-Pattern 2: Installing opencode Globally on CI Runners

**What:** Running `curl -fsSL https://opencode.ai/install | bash` in CI without pinning a version.
**Why bad:** The install script downloads the latest binary. A breaking change in opencode could fail CI without any change to the eval codebase. The linux-arm64 binary has known stability issues.
**Instead:** Pin a specific opencode version in CI. Use a cached binary. Have a fallback to `--agent=ollama` if opencode installation fails.

### Anti-Pattern 3: Running Agent and Grader Models Concurrently

**What:** Having the agent model and grader model both loaded in Ollama simultaneously.
**Why bad:** On 16 GB RAM, an 8B Q4 agent model (~5-6 GB) plus a 3B grader model (~2 GB) plus OS/Docker/Node.js (~3-4 GB) exceeds available memory, causing OOM or swapping.
**Instead:** Use `keep_alive: "0"` on agent model requests so Ollama unloads the agent model when the agent is done. The grader model loads into the freed memory. This is sequential but safe.

### Anti-Pattern 4: Creating a New Grader Type for Local LLM

**What:** Adding a separate `LocalLLMGrader` class and `local_llm_rubric` type.
**Why bad:** The existing `LLMGrader` already has Ollama as its primary provider with a cloud fallback chain. It already calls `/api/generate` to Ollama. Creating a parallel grader class duplicates the prompt building, response parsing, and retry logic.
**Instead:** The existing `LLMGrader` is sufficient for v2.0. It already works with Ollama. No grader changes needed. (This corrects the previous v1.0 research recommendation.)

## Integration Points Detailed

### 1. CLI Layer (`src/cli.ts`)

Current agent selection (line 59):
```typescript
const agentType = args.find(a => a.startsWith('--agent='))?.split('=')[1] || 'gemini';
```

Modified to support new agents:
```typescript
const agentType = args.find(a => a.startsWith('--agent='))?.split('=')[1] || 'gemini';
// ... later in the eval block:
let agent: BaseAgent;
switch (agentType) {
    case 'gemini':  agent = new GeminiAgent(); break;
    case 'claude':  agent = new ClaudeAgent(); break;
    case 'opencode': agent = new OpenCodeAgent(taskConfig.agent.backend?.model); break;
    case 'ollama':  agent = new OllamaToolAgent(taskConfig.agent.backend?.model); break;
    default: throw new Error(`Unknown agent type: ${agentType}`);
}
```

### 2. Provider Skill Injection

Both `LocalProvider` and `DockerProvider` inject skills into agent-specific discovery directories. opencode uses `.opencode/skills/` (or `.opencode/agents/` for agent definitions).

In `src/providers/local.ts`, add to the `discoveryDirs` array:
```typescript
const discoveryDirs = [
    path.join(tempDir, '.agents', 'skills'),   // Gemini
    path.join(tempDir, '.claude', 'skills'),    // Claude Code
    path.join(tempDir, '.opencode', 'skills'),  // opencode (NEW)
];
```

In `src/providers/docker.ts`, add to the `discoveryDirs` array in `prepare()`:
```typescript
const discoveryDirs = [
    '/workspace/.agents/skills',
    '/workspace/.claude/skills',
    '/workspace/.opencode/skills',  // opencode (NEW)
];
```

### 3. opencode Configuration Injection (in Provider or Agent)

The opencode agent needs `opencode.json` in the workspace. Two approaches:

**Option A: Agent writes config via runCommand** (preferred -- keeps provider unchanged):
```typescript
// In OpenCodeAgent.run(), before invoking opencode:
const configJson = JSON.stringify({
    model: `ollama/${this.model}`,
    provider: { ollama: { ... } },
    permission: { edit: "allow", bash: "allow" }
});
const b64Config = Buffer.from(configJson).toString('base64');
await runCommand(`echo '${b64Config}' | base64 -d > opencode.json`);
```

**Option B: Provider writes config during setup** (cleaner if multiple agents need it):
```typescript
// In LocalProvider.setup(), after copying task files:
if (agentRequiresOpencode) {
    await fs.writeJSON(path.join(tempDir, 'opencode.json'), opencodeConfig);
}
```

Option A is preferred because it does not require the provider to know which agent will run. The agent is responsible for its own configuration, matching the existing pattern where agents manage their own invocation commands.

### 4. Ollama Model Preparation

The agent model needs a larger context window than the default 4K. Two strategies:

**Strategy A: Custom Modelfile (offline, one-time)**
```bash
# Create a custom model with 32K context
cat > /tmp/Modelfile << 'EOF'
FROM qwen3:8b
PARAMETER num_ctx 32768
EOF
ollama create qwen3:8b-32k -f /tmp/Modelfile
```

**Strategy B: num_ctx in API request (per-request, no custom model)**
The `OllamaToolAgent` can pass `num_ctx` in the options of each `/api/chat` request. This avoids creating custom models but means the context window is set per request.

Strategy A is preferred for CI (stable, cacheable model). Strategy B is acceptable for local development.

### 5. CI Workflow Extension

Add opencode agent evaluation to `skill-eval.yml`:

```yaml
  eval-agent:
    name: Eval (agent)
    runs-on: ubuntu-24.04-arm
    timeout-minutes: 30
    steps:
      - uses: actions/checkout@v4
      - uses: ./.github/actions/setup-node
      - uses: ./.github/actions/setup-ollama
        with:
          models: 'qwen3:8b,qwen2.5:3b'  # Agent + grader models
      - name: Create agent model with 32K context
        run: |
          echo 'FROM qwen3:8b' > /tmp/Modelfile
          echo 'PARAMETER num_ctx 32768' >> /tmp/Modelfile
          ollama create qwen3:8b-32k -f /tmp/Modelfile
      - name: Run agent evaluation
        run: npm run eval -- superlint_demo --agent=ollama --provider=local --trials=1
      - uses: actions/upload-artifact@v4
        if: always()
        with:
          name: eval-results-agent
          path: results/
```

Note: Uses `--agent=ollama` (direct tool-use) rather than `--agent=opencode` due to the linux-arm64 binary stability issue. Switch to `--agent=opencode` once issue #13367 is resolved.

## Suggested Build Order

### Phase 1: OllamaToolAgent (Direct Tool-Use Agent)

**Why first:** No external CLI dependency. Works on all platforms where Ollama runs. Validates the tool-calling model works with the eval framework before adding opencode complexity.

Build:
1. Install `ollama` npm package
2. Implement `OllamaToolAgent` in `src/agents/ollama.ts`
3. Define tool schemas (read_file, write_file, bash, list_directory)
4. Implement tool execution via `runCommand()`
5. Add `--agent=ollama` to CLI
6. Extend `TaskConfig` with `[agent.backend]` section
7. Test with `superlint_demo` task locally
8. Validate on CI with ubuntu-24.04-arm

### Phase 2: opencode Agent Integration

**Why second:** Depends on opencode binary being installable on target platform. The OllamaToolAgent from Phase 1 provides a working baseline for comparison.

Build:
1. Validate opencode installability on Windows ARM64 (x64 emulation) and CI runner
2. Implement `OpenCodeAgent` in `src/agents/opencode.ts`
3. Implement opencode.json configuration injection
4. Add `.opencode/skills/` to skill injection paths in both providers
5. Add `--agent=opencode` to CLI
6. Test with `superlint_demo` task
7. Compare results with OllamaToolAgent

### Phase 3: CI Integration

**Why third:** CI validation is the final proof. By this point, both agent paths exist and the one that works on ubuntu-24.04-arm is used.

Build:
1. Add agent model (qwen3:8b) to setup-ollama composite action
2. Create Modelfile for 32K context variant
3. Add eval-agent job to skill-eval.yml
4. Cache agent model alongside grader model
5. Set timeout to 15 minutes per trial

## Platform Compatibility Matrix

| Platform | opencode | OllamaToolAgent | LLMGrader (existing) |
|----------|----------|-----------------|---------------------|
| Windows ARM64 (local dev) | NO binary (issue #4340) | YES (Ollama runs natively) | YES (already working) |
| Windows x64 emulation | MAYBE (stability issues reported) | YES | YES |
| WSL2 Ubuntu x64 | YES | YES | YES |
| ubuntu-24.04-arm (CI) | MAYBE (SIGABRT crash, issue #13367) | YES (Ollama ARM64 stable) | YES (already working) |
| ubuntu-24.04 x64 (CI) | YES | YES | YES |

**Conclusion:** `OllamaToolAgent` is the only agent that works reliably on all target platforms. It should be the primary agent, with opencode as an enhancement for platforms where it works.

## Sources

- [OpenCode CLI Documentation](https://opencode.ai/docs/cli/) -- HIGH confidence (official docs, verified via WebFetch)
- [OpenCode Config Documentation](https://opencode.ai/docs/config/) -- HIGH confidence (official docs, verified via WebFetch)
- [OpenCode Providers Documentation](https://opencode.ai/docs/providers/) -- HIGH confidence (official docs, verified via WebFetch)
- [Ollama OpenCode Integration](https://docs.ollama.com/integrations/opencode) -- HIGH confidence (official Ollama docs)
- [Ollama Tool Calling Documentation](https://docs.ollama.com/capabilities/tool-calling) -- HIGH confidence (official docs, TypeScript examples verified)
- [OpenCode Windows ARM64 Issue #4340](https://github.com/anomalyco/opencode/issues/4340) -- HIGH confidence (open issue, blocked by Bun upstream)
- [OpenCode linux-arm64 SIGABRT Issue #13367](https://github.com/anomalyco/opencode/issues/13367) -- HIGH confidence (open issue, verified unresolved)
- [OpenCode Non-Interactive Mode Issue #10411](https://github.com/anomalyco/opencode/issues/10411) -- MEDIUM confidence (feature request, may be resolved in newer versions)
- [OpenCode YOLO Mode Issue #8463](https://github.com/anomalyco/opencode/issues/8463) -- MEDIUM confidence (proposed, implementation status unclear)
- [Ollama v0.14 Agent Loop](https://www.phoronix.com/news/ollama-0.14-rc2) -- MEDIUM confidence (news article about experimental feature)
- [tiny-coding-agent](https://github.com/jellydn/tiny-coding-agent) -- MEDIUM confidence (reference implementation for TypeScript tool-calling agent)

---

*Architecture research: 2026-03-10 (v2.0 milestone, supersedes 2026-03-08 initial research)*
