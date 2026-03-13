# Feature Research

**Domain:** opencode + Ollama agent backend for local skill evaluation
**Researched:** 2026-03-10
**Confidence:** MEDIUM-HIGH

## Feature Landscape

This research focuses exclusively on features needed for the v2.0 milestone: running skill evaluations using opencode CLI backed by Ollama as the agent (not just grader). The existing v1.0 infrastructure (LLMGrader, Docker isolation, CLI runner, CI pipeline) is assumed working.

### Table Stakes (Users Expect These)

Features required for opencode+Ollama agent evaluation to work end-to-end. Missing any of these means the eval pipeline cannot produce results.

#### OpenCode Agent Integration

| Feature | Why Expected | Complexity | Notes |
|---------|--------------|------------|-------|
| `OpenCodeAgent` class implementing `BaseAgent` | Existing pattern: `ClaudeAgent` and `GeminiAgent` both extend `BaseAgent` with a `run()` method. Users expect the same for opencode. | LOW | Follow exact pattern from `src/agents/claude.ts`. Core: write instruction to temp file, invoke `opencode run -q "$(cat /tmp/.prompt.md)"`, capture stdout+stderr. The `-q` flag suppresses spinner for scripting. |
| opencode Ollama provider config | opencode must know how to talk to Ollama. Without config, `opencode run` defaults to cloud models or errors out. | LOW | Write `opencode.json` to workspace (or `~/.config/opencode/opencode.json`). Config uses `@ai-sdk/openai-compatible` npm package pointing to `http://localhost:11434/v1`. Already documented in Ollama official integration docs. |
| Model selection via `--model` flag | Users need to specify which Ollama model the agent uses. The CLI `--agent=opencode` flag exists; model selection needs a companion `--model=ollama/<name>` flag. | LOW | Pass `--model ollama/<model_name>` to `opencode run`. Requires the model to be listed in the opencode.json provider config under `models`. Extend `cli.ts` to accept `--model=` flag and pass to agent constructor. |
| Non-interactive permissions (auto-approve all) | opencode prompts for permission on file writes and bash commands. In eval mode, no human is present to approve. The agent must run fully autonomously. | MEDIUM | Three complementary approaches: (1) opencode's non-interactive mode auto-approves when run via `opencode run` (confirmed in docs: "All permissions are auto-approved for the session"). (2) Config-based: set `"permission": "allow"` in opencode.json. (3) Env-based: `OPENCODE_PERMISSION` JSON string. The `opencode run` default auto-approve is the simplest path. Known risk: Issues #5888 and #10411 report hangs in CI. |
| Context window configuration (num_ctx) | Ollama defaults to 4096 tokens context. opencode needs much more for agentic coding. Without this, the agent silently degrades -- truncated context causes nonsensical tool calls. | MEDIUM | Create a custom model variant: `FROM qwen3:8b` / `PARAMETER num_ctx 32768` in a Modelfile, then `ollama create qwen3:8b-32k -f Modelfile`. Start with 16K-32K (not 64K) because 64K context adds 5-8GB KV cache on top of model weights, exceeding 16GB RAM. |
| Ollama model with tool calling support | opencode uses tools (read, edit, bash, glob, grep) to accomplish tasks. The underlying Ollama model must support function calling. Not all models do. | MEDIUM | Use models tagged with "tools" on ollama.com/library. Verified candidates for 16GB RAM: qwen3:8b (5-6GB Q4, native tool calling), qwen3.5:4b (3.4GB, strong tool calling per BFCL benchmarks), qwen3.5:9b (5-6GB Q4, best coding+tools at this tier). |
| Ollama health check before agent run | Existing v1.0 grader checks Ollama liveness. Agent runs need the same check plus agent model availability verification. | LOW | Reuse existing `GET /` and `GET /api/tags` checks. Add model-specific availability check for the agent model (may differ from grader model). |

#### Agent-Grader Resource Coordination

| Feature | Why Expected | Complexity | Notes |
|---------|--------------|------------|-------|
| Sequential model loading (agent then grader) | On 16GB RAM (CI runner), loading agent model (5-6GB) and grader model (qwen2.5:3b, ~2GB) simultaneously risks OOM. | MEDIUM | Sequence: (1) Load agent model with `keep_alive: -1`. (2) Run agent. (3) Unload agent model with `keep_alive: 0` via `POST /api/generate`. (4) Load grader model. (5) Grade. The existing `EvalRunner.runSingleTrial()` already sequences agent-then-grader, but needs explicit model unload between them. |
| Model routing (agent vs grader) | Agent model (qwen3:8b or qwen3.5:9b) differs from grader model (qwen2.5:3b). These must be independently configurable. | LOW | Already natural from architecture: `task.toml [[graders]]` section controls grader model, `cli.ts --model` flag controls agent model. Just needs documentation and validation that both models exist before starting eval. |
| Per-trial timeout extended to 15 minutes | Current `task.toml` has `timeout_sec = 300` (5 min). Local LLM agents are 5-10x slower than cloud agents. 15 minutes per trial is the PROJECT.md target. | LOW | Change `timeout_sec` in task.toml to 900. The `withTimeout()` in `evalRunner.ts` already respects this. May also need to configure opencode's own step limit to not hit its internal limit before our timeout. |

#### Eval Pipeline Adaptations

| Feature | Why Expected | Complexity | Notes |
|---------|--------------|------------|-------|
| `--agent=opencode` CLI flag | Existing CLI supports `--agent=gemini` and `--agent=claude`. Users expect `--agent=opencode` to work identically. | LOW | Add `OpenCodeAgent` to the agent selection switch in `cli.ts`. Three-line change. |
| opencode installation in CI | CI runners do not have opencode pre-installed. | LOW | `curl -fsSL https://opencode.ai/install \| bash` in CI setup step. Cache the binary. Already have a composite action pattern from v1.0 (`setup-ollama`). Create matching `setup-opencode` composite action. |
| Ollama model pull + context config in CI | CI needs the agent model pulled and configured with appropriate context window before eval starts. | MEDIUM | Extend existing `setup-ollama` composite action: (1) Pull agent model. (2) Create custom model variant with num_ctx via Modelfile. (3) Warmup to load into memory. Already have model caching via `actions/cache@v5` for `~/.ollama`. |
| opencode config generation in CI | CI needs opencode.json written before eval runs. Cannot rely on user's local config. | LOW | Generate opencode.json programmatically in CI setup step. Template the model name from workflow input/env var. Write to `~/.config/opencode/opencode.json`. |

### Differentiators (Competitive Advantage)

Features that make local-skill-eval uniquely valuable for evaluating local LLM agents. Not required for basic operation but significantly improve the evaluation experience.

| Feature | Value Proposition | Complexity | Notes |
|---------|-------------------|------------|-------|
| Direct Ollama agent fallback | If opencode+Ollama proves unworkable (permission hangs, tool calling failures, ARM64 issues), a minimal agent using Ollama's raw tool calling API provides a reliable backup. This is PROJECT.md's explicit fallback plan. | HIGH | Build `OllamaDirectAgent` implementing `BaseAgent`. Define tools (read_file, write_file, bash) as Ollama tool schemas. Implement agentic loop: prompt -> tool_calls -> execute -> feed results back. 200-400 lines of TypeScript. Zero external CLI dependency. |
| `ollama launch opencode` integration | Zero-config setup: detect when user has run `ollama launch opencode --config` and auto-discover the model. Eliminates manual opencode.json management. | MEDIUM | Detect existence of `~/.config/opencode/opencode.json` with Ollama provider, parse the model name, use it as agent model. Falls back to explicit `--model` flag. Requires Ollama v0.15+. |
| opencode `--format json` output parsing | Capture structured JSON events from opencode's run, including tool calls, thinking steps, and token usage. Enables richer session logs than raw stdout capture. | MEDIUM | Use `opencode run --format json -q` instead of default output. Parse NDJSON events: `message.part.updated` (thinking, tool calls), `step_finish` (token usage, cost). Map to existing `LogEntry` types. Provides accurate token counts instead of heuristic estimates. |
| Skills efficacy measurement (vanilla vs skills) | Run each task with and without skills, measuring the delta. Directly implements the SkillsBench (2026) methodology. Unique differentiator: no other local eval tool does this systematically. | LOW | Already supported via `--no-skills` flag. Add `--compare-skills` mode that runs both variants and reports delta. Minimal code change: two eval runs, one diff report. |
| Agent step/tool efficiency metrics | Track number of tool calls, types of tools used, redundant calls, and total steps. Goes beyond pass/fail to measure how efficiently the agent works. | LOW | opencode's `--format json` output includes tool call events. Count total tool calls, unique tools used, and steps to completion. Add to `TrialResult` as new fields. Aligns with DeepEval's `StepEfficiencyMetric`. |
| Multi-model agent benchmarking | Run the same task with different Ollama models and compare pass rates, efficiency, and timing. | LOW | Already supported by running eval multiple times with different `--model` flags. Add a `--models=a,b,c` convenience flag that runs all variants sequentially and produces a comparison table. |
| Warm-start server mode | Use `opencode serve` + `opencode run --attach` to avoid MCP server cold boot on every trial. Reduces per-trial overhead for multi-trial evals. | MEDIUM | Start `opencode serve` before eval loop, pass server URL to each `opencode run --attach <url>` invocation. Kill server after all trials. Saves 5-15 seconds per trial on MCP initialization. |
| Model warmup for agent | Preload agent model before first trial to avoid cold start within the 15-minute budget. | LOW | Extend existing warmup pattern (v1.0): send empty generate request for agent model in addition to grader model. |

### Anti-Features (Commonly Requested, Often Problematic)

Features that seem valuable but would hurt this project in its current milestone.

| Feature | Why Requested | Why Problematic | Alternative |
|---------|---------------|-----------------|-------------|
| 64K context window for agent model | "opencode recommends 64K context" | At 64K, an 8B model's KV cache alone is 5-8GB. Combined with 5-6GB model weights, exceeds 16GB total RAM. OOM guaranteed on target hardware and CI runners. | Start with 16K-32K context. The superlint_demo task is simple (3-step workflow). 16K is sufficient. Increase only if tasks demonstrate context exhaustion. |
| Parallel agent trials with local LLM | "Run 5 trials at once" | Each opencode+Ollama trial loads the agent model (~5-6GB). Two concurrent trials = 12GB+ just for agent models, leaving no room for Docker, Node.js, OS. Ollama serializes same-model requests anyway. | Sequential trials (existing default). The 15-minute per-trial budget accounts for this. |
| Cloud model fallback during agent eval | "If local model fails, fall back to Gemini/Claude" | Creates non-comparable evaluation conditions. Trial 1 with qwen3:8b and trial 2 with Claude produce scores that cannot be meaningfully averaged. Defeats the "local-only" value proposition. | One model per eval run. Use `--model` to select. Run separate evals for each model if comparison is needed. |
| Real-time agent output streaming | "Stream opencode's thinking as it happens" | Complicates output capture, breaks JSON event parsing, adds UI complexity. Eval is a batch operation -- the result matters, not intermediate tokens. | Capture full output, display summary after trial completes. Use `--format json` for structured post-hoc analysis. |
| Custom opencode tool definitions | "Define eval-specific tools for the agent" | Changes what is being measured. The eval should test the agent's standard capabilities against the task. Custom tools invalidate the benchmark. | Use opencode's built-in tools: read, edit, bash, glob, grep. They cover everything the superlint_demo task needs. |
| GPU/NPU acceleration | "Speed up inference" | Snapdragon Adreno X1-85 has no ML support. Qualcomm NPU requires ONNX, not GGUF. Ollama on ARM64 Windows is CPU-only. Dead end for this hardware. | Accept CPU inference speed (~10-15 tok/s for 8B model on Snapdragon X Elite). 15-minute timeout accommodates this. |
| opencode TUI mode for eval | "Watch the agent work interactively" | Incompatible with programmatic capture. TUI takes over the terminal, cannot be piped to a log file, and requires manual exit. Breaks `BaseAgent.run()` contract. | Use `opencode run` (non-interactive CLI mode). Designed for scripting and automation. |
| Full agent framework (LangChain/LangGraph) for fallback | "Use a proper framework" | Massive dependency surface (50+ packages). The fallback agent needs 3 tools and a loop -- a framework is overkill and adds weeks of integration. | Build minimal `OllamaDirectAgent` using raw Ollama `/api/chat` with tools. TypeScript only, zero extra dependencies. |
| Score normalization across agent models | "Normalize so different models are comparable" | Premature. First need to prove ANY local model can pass superlint_demo. Explicitly out of scope in PROJECT.md. | Compare raw scores. Document that scores are model-specific. Add normalization in a future milestone if needed. |
| Windows ARM64 opencode workarounds | "Make opencode work natively on Snapdragon" | opencode is a Go binary with x86_64 distribution. Running under QEMU emulation on ARM64 Windows adds latency and risks segfaults. | Use CI (ubuntu-24.04-arm, where opencode runs natively) for opencode testing. Use direct Ollama agent path for local Windows development. |

## Feature Dependencies

```
[Ollama Health Check (existing v1.0)]
    |
    +--enables--> [OpenCodeAgent class]
    |                  |
    |                  +--requires--> [opencode Ollama provider config]
    |                  |                  |
    |                  |                  +--requires--> [Model with tool calling support]
    |                  |                  |
    |                  |                  +--requires--> [Context window config (num_ctx)]
    |                  |
    |                  +--requires--> [Non-interactive permissions]
    |                  |
    |                  +--enhances--> [JSON output parsing (--format json)]
    |                  |
    |                  +--enhances--> [Warm-start server mode]
    |
    +--enables--> [Sequential model loading]
    |                  |
    |                  +--requires--> [Model routing (agent vs grader)]
    |                  +--requires--> [Model warmup for agent]
    |
    +--enables--> [OllamaDirectAgent (fallback)]
                       |
                       +--requires--> [Ollama tool calling API]
                       +--requires--> [Tool definitions (read, write, bash)]
                       +--requires--> [Agentic loop implementation]

[OpenCodeAgent]
    +--enables--> [--agent=opencode CLI flag]
    |                  |
    |                  +--enables--> [Multi-model benchmarking]
    |
    +--enables--> [CI integration (setup-opencode)]
    |                  |
    |                  +--requires--> [opencode config generation in CI]
    |                  +--requires--> [Ollama model pull + context config in CI]
    |
    +--enables--> [ollama launch integration]
    |
    +--enables--> [Skills efficacy measurement]
    |
    +--enables--> [Agent step/tool efficiency metrics]

[OllamaDirectAgent] --conflicts--> [ollama launch integration]
    (fallback path bypasses opencode; ollama launch is opencode-specific)
```

### Dependency Notes

- **OpenCodeAgent requires Non-interactive permissions:** Without auto-approve, `opencode run` hangs waiting for user input. CI jobs hang indefinitely. Most common failure reported in opencode GitHub issues (#5888, #10411).
- **OpenCodeAgent requires Context window config:** Ollama's 4096 default truncates agent context after 2-3 tool calls. The agent loses track of what it has done and repeats actions or hallucinates. Silent degradation -- no error, just wrong behavior.
- **Model with tool calling requires verification:** Not all Ollama models support the `tools` API field. Models without tool support ignore tool definitions and produce plain text instead of `tool_calls` responses, causing opencode to error or hang.
- **Sequential model loading requires Model routing:** Must know which model is the agent (to unload) and which is the grader (to load). Without routing, both models may be loaded simultaneously, causing OOM.
- **OllamaDirectAgent conflicts with ollama launch:** The fallback bypasses opencode entirely, using Ollama's raw API. `ollama launch` only configures opencode. If we fall back to direct Ollama, the launch integration is moot.
- **Skills efficacy measurement depends on OpenCodeAgent working:** Cannot measure skills delta if the agent cannot complete tasks at all. Must prove basic task completion first.

## MVP Definition

### Launch With (v2.0 Phase 1 -- Prove It Works)

Minimum features to validate that opencode+Ollama can complete the superlint_demo task end-to-end.

- [ ] **Ollama agent model setup** -- Pull model, create context-window variant via Modelfile. Without a working model, nothing else matters.
- [ ] **OpenCodeAgent class** -- Extend `BaseAgent`. Invoke `opencode run -q`. Capture stdout+stderr. Without this, no agent eval happens.
- [ ] **opencode Ollama provider config** -- Generate `opencode.json` pointing to Ollama with selected model. Without config, opencode cannot talk to Ollama.
- [ ] **Non-interactive auto-approve** -- Verify `opencode run` auto-approves. Add `"permission": "allow"` in config as safety net. Without this, CI hangs.
- [ ] **`--agent=opencode --model=ollama/<name>` CLI flags** -- Wire into `cli.ts`. Entry point for running evals.
- [ ] **Sequential model loading** -- Unload agent model before loading grader model. Use `keep_alive: 0`. Without this, OOM on 16GB.
- [ ] **Extended timeout (15 min)** -- Update task.toml to 900s. Without this, every trial times out.

### Add After Validation (v2.0 Phase 2 -- Make It Robust)

Features to add once basic end-to-end task completion is proven.

- [ ] **CI integration** -- `setup-opencode` composite action, config generation, model pull+config. Trigger: local eval succeeds.
- [ ] **JSON output parsing** -- Use `--format json` for structured event capture, accurate token counts. Trigger: basic eval works but session logs lack detail.
- [ ] **ollama launch integration** -- Detect auto-generated config from `ollama launch opencode --config`. Trigger: manual config works, want simpler UX.
- [ ] **Agent efficiency metrics** -- Tool call count, types, steps-to-completion. Trigger: agent completes tasks, want quality metrics beyond pass/fail.
- [ ] **Model warmup for agent** -- Preload agent model before first trial. Trigger: cold-start penalty is measurable and significant.

### Future Consideration (v2.0 Phase 3 or v3+)

- [ ] **Direct Ollama agent fallback** -- Build `OllamaDirectAgent` with raw tool calling API. HIGH complexity. Defer unless opencode+Ollama proves unworkable.
- [ ] **Warm-start server mode** -- `opencode serve` + `--attach`. Defer until per-trial overhead is a measured bottleneck.
- [ ] **Skills efficacy measurement** -- `--compare-skills` mode. Defer until agent reliably passes tasks.
- [ ] **Multi-model comparison** -- `--models=a,b,c` convenience flag. Defer until one model works reliably.

## Feature Prioritization Matrix

| Feature | User Value | Implementation Cost | Priority | Depends On (existing) |
|---------|------------|---------------------|----------|----------------------|
| Ollama agent model setup | HIGH | LOW | P1 | Ollama setup (v1.0) |
| OpenCodeAgent class | HIGH | LOW | P1 | BaseAgent pattern (v1.0) |
| opencode Ollama provider config | HIGH | LOW | P1 | None |
| Non-interactive permissions | HIGH | LOW | P1 | opencode config |
| `--agent=opencode` CLI flag | HIGH | LOW | P1 | OpenCodeAgent class |
| Sequential model loading | HIGH | MEDIUM | P1 | Ollama API (v1.0) |
| Extended timeout (15 min) | HIGH | LOW | P1 | task.toml (v1.0) |
| CI integration (setup-opencode) | HIGH | MEDIUM | P2 | OpenCodeAgent working locally |
| JSON output parsing | MEDIUM | MEDIUM | P2 | OpenCodeAgent class |
| ollama launch integration | MEDIUM | MEDIUM | P2 | opencode config |
| Agent efficiency metrics | MEDIUM | LOW | P2 | JSON output parsing |
| Model warmup for agent | MEDIUM | LOW | P2 | Ollama API (v1.0) |
| Direct Ollama agent fallback | MEDIUM | HIGH | P3 | Ollama tool calling API |
| Multi-model comparison | LOW | LOW | P3 | `--agent=opencode` working |
| Warm-start server mode | LOW | MEDIUM | P3 | OpenCodeAgent class |
| Skills efficacy measurement | LOW | LOW | P3 | Agent passing tasks |

**Priority key:**
- P1: Must have -- validates that opencode+Ollama can complete superlint_demo end-to-end
- P2: Should have -- makes the eval pipeline robust and CI-ready
- P3: Nice to have / contingency -- fallback path or advanced features

## Competitor / Comparable Feature Analysis

| Feature | Upstream skill-eval | SkillsBench (2026) | opencode-bench | Our Approach |
|---------|--------------------|--------------------|----------------|--------------|
| Agent CLI | Gemini CLI, Claude Code | Terminal-Bench harness, Claude Code, Codex | opencode with cloud | opencode with Ollama backend (local-only) |
| Model backend | Cloud APIs | Cloud APIs | Cloud APIs (OpenCode Zen) | Ollama local inference |
| Task isolation | Docker containers | Docker containers (Harbor) | Fresh repo clones | Docker (existing) + local provider fallback |
| Grading | Deterministic + LLM rubric (cloud) | Deterministic only (binary) | Multi-LLM judges (5 dims) | Deterministic + LLM rubric (local Ollama) |
| Skills evaluation | Yes (skill injection) | Yes (vanilla vs skills) | No | Yes (inherited + delta planned) |
| Non-interactive agent | `claude --yes`, `gemini -y` | Harness-specific | `opencode run` | `opencode run -q` with auto-approve |
| Multi-trial stats | pass@k, pass^k | Binary pass rate (5 trials) | 3 episodes, variance-penalized | pass@k, pass^k (inherited) |
| Tool call tracking | Command count only | Not measured | Not measured | Tool call count + types (planned P2) |
| Offline capability | No (requires API keys) | No | No | Yes (complete offline, core value prop) |

## Ollama Model Recommendations for Agent Use

Candidates for the agent model on target hardware (16GB RAM, ARM64 CPU-only, with Docker + Node.js + grader model running):

| Model | Size (Q4) | Tool Calling | Max Context | Agent Quality | Fits 16GB w/ grader? | Recommendation |
|-------|-----------|-------------|-------------|---------------|---------------------|----------------|
| qwen3.5:4b | ~3.4GB | Strong (BFCL benchmarks) | 256K | Good for simple tasks | Yes (comfortable) | **Start here.** Leaves plenty of RAM for grader + Docker. Lower quality but safest on memory. Good proof-of-concept model. |
| qwen3:8b | ~5-6GB | Native (trained) | 128K | Good general agent | Yes (tight at 32K ctx) | **Primary candidate.** Best balance of quality and memory. Limit context to 16-32K to leave room for grader. |
| qwen3.5:9b | ~5-6GB | Strong (BFCL 66.1, TAU2 79.1) | 256K | Better coding + tools | Yes (tight at 32K ctx) | **Best quality if available.** Newer, better benchmarks than qwen3:8b. Check Ollama library availability. |
| qwen3-coder (30B-A3B MoE) | ~18GB | Yes | 256K | Best coding quality | No | **Not viable** on 16GB. Needs 23GB+ per Ollama team. |
| glm-4.7-flash | ~10GB | Yes | 128K | Good agentic coding | Marginal | **Risky.** Only ~6GB remaining for everything else. |

**Verdict:** Start with **qwen3.5:4b** at 16K context for initial proof-of-concept (lowest memory risk). If it passes superlint_demo, try **qwen3:8b** at 16-32K for better quality. Use **qwen3.5:9b** as the aspirational target if memory allows.

**Context window vs RAM tradeoff (8B model, Q4):**

| Context | Model Weights | KV Cache | Total | Fits 16GB w/ grader+Docker? |
|---------|--------------|----------|-------|----------------------------|
| 4K (default) | ~5.5GB | ~0.3GB | ~5.8GB | Yes (comfortable) |
| 16K | ~5.5GB | ~1.2GB | ~6.7GB | Yes |
| 32K | ~5.5GB | ~2.5GB | ~8.0GB | Tight (6GB for grader+Docker+OS) |
| 64K | ~5.5GB | ~5.0GB | ~10.5GB | No (only 5.5GB remaining) |

## opencode Agent Integration Reference

### Invocation Pattern

```typescript
// OpenCodeAgent.run() implementation sketch
export class OpenCodeAgent extends BaseAgent {
    constructor(private model: string) { super(); }

    async run(
        instruction: string,
        _workspacePath: string,
        runCommand: (cmd: string) => Promise<CommandResult>
    ): Promise<string> {
        const b64 = Buffer.from(instruction).toString('base64');
        await runCommand(`echo '${b64}' | base64 -d > /tmp/.prompt.md`);

        const command = `opencode run -q --model ${this.model} "$(cat /tmp/.prompt.md)"`;
        const result = await runCommand(command);

        if (result.exitCode !== 0) {
            console.error('OpenCodeAgent: opencode failed to execute correctly.');
        }

        return result.stdout + '\n' + result.stderr;
    }
}
```

### Config File (`opencode.json`)

```json
{
  "$schema": "https://opencode.ai/config.json",
  "provider": {
    "ollama": {
      "npm": "@ai-sdk/openai-compatible",
      "name": "Ollama",
      "options": {
        "baseURL": "http://localhost:11434/v1"
      },
      "models": {
        "qwen3:8b-32k": {
          "name": "qwen3:8b-32k"
        }
      }
    }
  },
  "permission": "allow"
}
```

### Model Preparation (Modelfile)

```dockerfile
FROM qwen3:8b
PARAMETER num_ctx 32768
PARAMETER temperature 0.1
```

```bash
ollama create qwen3:8b-32k -f Modelfile
```

## Direct Ollama Agent Fallback Reference

If opencode+Ollama proves unworkable, the fallback uses Ollama's native tool calling API directly.

### Tool Definition Schema

```typescript
const tools = [
  {
    type: "function",
    function: {
      name: "read_file",
      description: "Read the contents of a file",
      parameters: {
        type: "object",
        required: ["path"],
        properties: {
          path: { type: "string", description: "File path to read" }
        }
      }
    }
  },
  {
    type: "function",
    function: {
      name: "write_file",
      description: "Write content to a file",
      parameters: {
        type: "object",
        required: ["path", "content"],
        properties: {
          path: { type: "string", description: "File path to write" },
          content: { type: "string", description: "Content to write" }
        }
      }
    }
  },
  {
    type: "function",
    function: {
      name: "bash",
      description: "Execute a bash command and return stdout, stderr, and exit code",
      parameters: {
        type: "object",
        required: ["command"],
        properties: {
          command: { type: "string", description: "Bash command to execute" }
        }
      }
    }
  }
];
```

### Agentic Loop Pattern

```
1. Send instruction + tools to POST /api/chat
2. If response has tool_calls:
   a. Execute each tool call via provider.runCommand()
   b. Append tool results as role: "tool" messages
   c. Send updated conversation back to POST /api/chat
   d. Goto 2
3. If response has no tool_calls:
   a. Agent is done, return final message content
4. Safety: max 50 iterations (prevent infinite loops)
5. Safety: validate tool args against workspace directory
```

### Risk Assessment for Fallback Path

| Risk | Likelihood | Impact | Mitigation |
|------|-----------|--------|------------|
| Small models ignore tool definitions | MEDIUM | HIGH | Test with qwen3:8b (native training). Fall back to explicit prompting. |
| Infinite tool call loops | MEDIUM | MEDIUM | Max iteration count (50). Detect repeated identical calls. |
| Malformed tool call arguments | MEDIUM | MEDIUM | JSON schema validation on tool args before execution. |
| Model hallucinates file paths | HIGH | LOW | Validate paths against workspace directory. Reject paths outside. |
| Insufficient context for multi-step tasks | MEDIUM | HIGH | 32K minimum context. Track token usage, compact if needed. |
| Ollama 0.14+ experimental tools overlap | LOW | LOW | Use API-level tool calling, not `--experimental` CLI mode. |

## Sources

### Official Documentation (HIGH confidence)
- [OpenCode CLI Docs](https://opencode.ai/docs/cli/) -- `run` command, flags, output formats
- [OpenCode Config](https://opencode.ai/docs/config/) -- Provider config, permission settings, model config
- [OpenCode Permissions](https://opencode.ai/docs/permissions/) -- Permission actions, patterns, auto-approve
- [Ollama OpenCode Integration](https://docs.ollama.com/integrations/opencode) -- Official setup, recommended models
- [Ollama Tool Calling](https://docs.ollama.com/capabilities/tool-calling) -- API format, supported models, agentic loops
- [Ollama Launch Blog](https://ollama.com/blog/launch) -- ollama launch command, v0.15+, supported agents
- [Ollama Structured Outputs](https://docs.ollama.com/capabilities/structured-outputs) -- JSON schema format parameter
- [Ollama API Reference](https://github.com/ollama/ollama/blob/main/docs/api.md) -- Full API documentation

### Research Papers (HIGH confidence)
- [SkillsBench: Benchmarking How Well Agent Skills Work Across Diverse Tasks](https://arxiv.org/html/2602.12670v1) -- Skills efficacy measurement, containerized tasks, deterministic grading

### Agent Evaluation Methodology (MEDIUM confidence)
- [DeepEval Agent Evaluation Guide](https://deepeval.com/guides/guides-ai-agent-evaluation) -- TaskCompletionMetric, StepEfficiencyMetric
- [Amazon Agent Evaluation](https://aws.amazon.com/blogs/machine-learning/evaluating-ai-agents-real-world-lessons-from-building-agentic-systems-at-amazon/) -- Production thresholds, multi-run consistency
- [Confident AI Agent Evaluation](https://www.confident-ai.com/blog/llm-agent-evaluation-complete-guide) -- Tool correctness, tool calling efficiency

### Model Research (MEDIUM confidence)
- [Ollama VRAM Requirements 2026](https://localllm.in/blog/ollama-vram-requirements-for-local-llms) -- Memory per model tier, KV cache sizing
- [Best Ollama Models for Coding Agents 2026](https://www.clawctl.com/blog/best-local-llm-coding-2026) -- Model comparison, tool calling reliability
- [Qwen3 Official Blog](https://qwenlm.github.io/blog/qwen3/) -- Tool calling, model family overview
- [Qwen3.5 Guide (Unsloth)](https://unsloth.ai/docs/models/qwen3.5) -- Memory requirements, quantization
- [Qwen3.5 9B Coverage (VentureBeat)](https://venturebeat.com/technology/alibabas-small-open-source-qwen3-5-9b-beats-openais-gpt-oss-120b-and-can-run) -- Small model capabilities

### Community / Integration Guides (MEDIUM confidence)
- [p-lemonish/ollama-x-opencode](https://github.com/p-lemonish/ollama-x-opencode) -- Step-by-step setup, tool calling verification
- [IBM: Ollama Tool Calling for File Operations](https://www.ibm.com/think/tutorials/local-tool-calling-ollama-granite) -- File system tool calling tutorial
- [Shell AI: Agentic CLI powered by Ollama](https://github.com/nishant9083/shell-ai) -- TypeScript agent with file ops and bash tools
- [MCP-Ollama-Agent](https://github.com/ausboss/mcp-ollama-agent) -- TypeScript MCP-based Ollama agent

### GitHub Issues -- Real-World Failure Modes (MEDIUM confidence)
- [opencode #10411: Non-interactive mode request](https://github.com/anomalyco/opencode/issues/10411) -- Permission hang in scripting mode
- [opencode #5888: CI hangs](https://github.com/sst/opencode/issues/2330) -- opencode run hangs waiting for input
- [opencode #2923: JSON output missing with --command](https://github.com/anomalyco/opencode/issues/2923) -- --format json bug
- [Phoronix: Ollama 0.14 experimental tools](https://www.phoronix.com/news/ollama-0.14-rc2) -- `ollama run --experimental` agent loop

---
*Feature research for: opencode + Ollama agent backend (v2.0 milestone)*
*Researched: 2026-03-10*
