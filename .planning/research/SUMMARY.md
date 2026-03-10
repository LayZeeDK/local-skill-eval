# Project Research Summary

**Project:** local-skill-eval v2.0 -- opencode + Ollama Agent Backend
**Domain:** Local LLM agent evaluation framework
**Researched:** 2026-03-10
**Confidence:** HIGH (stack and pitfalls), MEDIUM-HIGH (features and architecture sequencing)

## Executive Summary

local-skill-eval v2.0 adds an agentic evaluation path to the existing skill-eval framework: instead of grading only static code or passively invoking a cloud CLI, the system now evaluates whether a local LLM-backed agent can autonomously complete software tasks within a Docker-isolated workspace. The recommended approach is to build two agent backends -- `OllamaToolAgent` (direct Ollama API with tool calling) as the primary cross-platform path, and `OpenCodeAgent` (wrapping the opencode CLI) as the enhanced path for CI where native ARM64 Linux binaries are available. Both extend the existing `BaseAgent` interface, leaving EvalRunner, graders, and providers unchanged.

The single most important risk is platform coverage: opencode ships no Windows ARM64 binary (GitHub issues #4340, #9678, #10302) and has a known SIGABRT crash on ubuntu-24.04-arm (issue #13367). This makes opencode unreliable on both the primary development machine (Snapdragon X Elite) and the CI target. The `OllamaToolAgent` -- a ~200-400 line TypeScript agent loop using the `ollama` npm client's tool-calling API -- avoids all external CLI dependencies and is the only path that works reliably on every target platform. Build it first; add opencode second. This inverts the ordering suggested in PROJECT.md but is the correct architectural decision given the platform constraints.

The secondary risk cluster is Ollama configuration: the 4K default context window silently breaks tool calling within 2-3 exchanges, tool calls can be emitted as plain text rather than structured API responses on mismatched model templates, and running agent and grader models concurrently on a 16 GB RAM runner causes OOM. All three are preventable with upfront configuration -- custom Modelfile with `num_ctx 32768`, Ollama pinned to v0.17.7, `OLLAMA_MAX_LOADED_MODELS=1` -- but they manifest silently and look identical to model capability failures if not instrumented with a tool-calling smoke test.

## Key Findings

### Recommended Stack

The existing stack (TypeScript 5.9+, Node.js 24+, Ollama server, qwen2.5:3b grader, GitHub Actions on ubuntu-24.04-arm, Docker, `dockerode`) is unchanged. v2.0 adds exactly one npm dependency (`ollama@0.6.3`, may already be present) and one Ollama model (`qwen3:8b`, 5.2 GB Q4_K_M). The opencode CLI is a CI-only install and not a project npm dependency.

**Core technologies:**
- `ollama` npm 0.6.3: Node.js client for Ollama chat API with tool calling -- already validated for grading; tool calling is a documented API feature with TypeScript types included
- `qwen3:8b` (Q4_K_M, ~5.2 GB): Agent model with native tool-calling training -- fits in 16 GB with 16K-32K context (~8 GB total), matching qwen2.5-14b quality at half the RAM
- opencode v1.2.23 (CI only): Coding agent CLI (Go binary, 45K+ stars) with `opencode run` for non-interactive automation -- native ARM64 Linux binary works in CI; no Windows ARM64 support
- Custom Modelfile (`qwen3:8b-32k`): Overrides Ollama's 4K default context to 32K -- required for any multi-step agentic workflow

**Critical version constraints:**
- Ollama must be pinned to v0.17.7 -- the first version fixing Qwen 3/3.5 tool call streaming parser bugs
- qwen3-coder:30b-a3b (MoE, 18.6 GB) does NOT fit in 16 GB RAM -- weights alone exceed the limit
- 64K context for an 8B model consumes ~10.5 GB total, leaving only 5.5 GB for everything else -- 32K is the ceiling

### Expected Features

**Must have (P1 -- proves opencode+Ollama end-to-end):**
- Ollama agent model setup: pull qwen3:8b, create 32K context variant via Modelfile -- without this, nothing else works
- `OllamaToolAgent` class extending `BaseAgent` with read/write/bash/list tool loop -- cross-platform, zero external CLI dependency
- `OpenCodeAgent` class extending `BaseAgent` -- invokes `opencode run -q --model ollama/qwen3:8b-32k "$(cat /tmp/.prompt.md)"`
- opencode.json configuration injection into workspace -- Ollama provider, `"permission": { "*": "allow" }`, `autoupdate: false`
- Non-interactive auto-approve -- explicit config-level permission grant, not relying on defaults
- `--agent=opencode` and `--agent=ollama` CLI flags in `cli.ts`
- Sequential model loading: unload agent model with `keep_alive: "0"` before grader loads
- Extended timeout: `timeout_sec = 900` in task.toml (15 minutes per trial)
- Tool-calling smoke test: pre-eval gate asserting structured `tool_calls` in API response

**Should have (P2 -- makes eval pipeline robust and CI-ready):**
- CI integration: `setup-opencode` composite action, opencode.json generation, agent model pull + Modelfile variant in `setup-ollama`
- `--format json` output parsing from opencode for structured event capture and accurate token counts
- Agent efficiency metrics: tool call count, types, steps-to-completion (enabled by JSON output)
- Model warmup for agent model (extend existing `LLMGrader.warmUp` pattern)
- `OLLAMA_MAX_LOADED_MODELS=1` in CI `setup-ollama` action

**Defer (P3 / v3+):**
- `--compare-skills` mode for skills efficacy delta -- requires agent reliably passing tasks first
- `--models=a,b,c` multi-model comparison convenience flag
- `ollama launch opencode` auto-config detection -- nice UX, but manual config must work first
- Warm-start server mode (`opencode serve` + `--attach`) -- defer until per-trial overhead is a measured bottleneck

**Anti-features (do not build):**
- 64K context window -- OOM on target hardware
- Parallel agent trials -- Ollama serializes same-model requests; two concurrent 8B models exceed 16 GB
- Cloud model fallback during agent eval -- creates non-comparable evaluation conditions
- Full agent framework (LangChain/LangGraph) for OllamaToolAgent -- the `ollama` npm client with 3 tools and a loop is sufficient

### Architecture Approach

The existing EvalRunner -> Agents -> Providers -> Graders layered architecture requires minimal changes. The `BaseAgent` abstract class, both providers (`DockerProvider`, `LocalProvider`), both graders (`DeterministicGrader`, `LLMGrader`), the report format, and the CI workflow structure are all unchanged. New work is scoped to two new agent classes in `src/agents/`, skill injection path additions (`.opencode/skills/`) to both providers, a `TaskConfig` type extension for `[agent.backend]`, and CLI flag additions. The opencode agent writes its own `opencode.json` config via `runCommand` before invoking the CLI -- this keeps providers unaware of which agent will run, consistent with the existing responsibility boundary.

**Major components:**
1. `src/agents/ollama.ts` (`OllamaToolAgent`) -- direct Ollama `/api/chat` with 4 tool definitions (read_file, write_file, bash, list_directory); agentic loop up to 50 turns; executes tools via `runCommand()`; primary cross-platform path
2. `src/agents/opencode.ts` (`OpenCodeAgent`) -- writes `opencode.json`, invokes `opencode run -q --model ollama/... "$(cat /tmp/.prompt.md)"`, captures stdout+stderr; enhanced path for CI ARM64 Linux
3. `src/cli.ts` (modified) -- adds `case 'opencode':` and `case 'ollama':` to agent selection switch; reads `taskConfig.agent.backend?.model`
4. `tasks/superlint_demo/task.toml` (modified) -- adds `[agent.backend]` section (`model = "qwen3:8b-32k"`, `timeout_sec = 900`)
5. Ollama server (shared, unchanged) -- serves both agent model (via `/api/chat` or `/v1/chat/completions`) and grader model (`/api/generate`); models loaded sequentially, never simultaneously

**Key architectural constraint -- opencode runs on host, not in Docker:**
The Docker provider isolates the workspace filesystem only. The opencode CLI and the OllamaToolAgent both run on the host machine, with Ollama on the host. Docker is workspace isolation, not agent execution isolation. This is consistent with how GeminiAgent and ClaudeAgent already work.

### Critical Pitfalls

1. **Ollama 4K default context silently breaks tool calling** -- Create `qwen3:8b-32k` via Modelfile (`PARAMETER num_ctx 32768`) before any eval. Verify with `ollama ps` that the loaded model shows 32K context, not 4K. This is the most reported failure mode by opencode+Ollama users.

2. **opencode `run` hangs indefinitely on errors (issue #8203)** -- Wrap every `opencode run` subprocess with an external kill timer via Node.js `child_process.spawn` with a timeout, not just `withTimeout()` on the promise. Monitor stderr for error patterns and kill proactively.

3. **OOM from agent model + grader model both loaded on 16 GB RAM** -- Set `OLLAMA_MAX_LOADED_MODELS=1` in CI. Use `keep_alive: "0"` on agent model API requests to unload immediately after the agent completes. Never load both models simultaneously.

4. **Tool calls emitted as plain text instead of structured API responses (issue #7486)** -- Only use models from Ollama's verified "tools" category. Build a tool-calling smoke test that asserts `tool_calls` field is present in the API response before running any evaluation. qwen3:8b is the verified candidate.

5. **opencode config precedence causes silent model/permission overrides** -- Set `OPENCODE_CONFIG_DIR` to a workspace-local path in CI to avoid inheriting global configs. Write ALL required fields explicitly in the project `opencode.json` -- never rely on inherited defaults.

6. **opencode has no Windows ARM64 binary and crashes on ubuntu-24.04-arm (issues #4340, #13367)** -- Build `OllamaToolAgent` as the primary agent; opencode is secondary. Use `--agent=ollama` (not `--agent=opencode`) in CI until issue #13367 is confirmed resolved.

## Implications for Roadmap

Based on combined research, the suggested 3-phase structure follows the architecture's own recommended build order: validate the platform-safe path first, add the CLI-dependent path second, then add robustness and metrics.

### Phase 1: OllamaToolAgent + Core Configuration

**Rationale:** No external CLI dependency. Works on all platforms where Ollama runs -- Windows ARM64 local dev, ubuntu-24.04-arm CI. Validates the tool-calling model and configuration before adding opencode complexity. All six critical pitfalls that must be addressed in Phase 1 apply here: context window, subprocess lifecycle, tool call smoke test, config precedence, Ollama version pinning, and model selection.

**Delivers:** End-to-end agent evaluation that runs locally on Windows ARM64. `npm run eval -- superlint_demo --agent=ollama --provider=local --trials=1` completes and produces a scored result.

**Addresses (from FEATURES.md P1):**
- Ollama agent model setup (pull qwen3:8b, create 32K context Modelfile variant)
- `OllamaToolAgent` class with 4-tool agentic loop (read_file, write_file, bash, list_directory)
- `--agent=ollama` CLI flag
- Sequential model loading with `keep_alive: "0"`
- Extended timeout (`task.toml` `timeout_sec = 900`)
- Tool-calling smoke test as pre-eval validation gate

**Avoids (from PITFALLS.md):**
- Pitfall 1: Custom Modelfile with `num_ctx 32768` created before any eval
- Pitfall 3: `OLLAMA_MAX_LOADED_MODELS=1` + `keep_alive: "0"` on agent model requests
- Pitfall 4: Smoke test asserts structured `tool_calls` in API response before eval begins
- Pitfall 6: Ollama pinned to v0.17.7 in `setup-ollama/action.yml`

**Research flags:** LOW -- OllamaToolAgent is a standard tool-calling loop with well-documented Ollama API patterns and verified TypeScript examples in STACK.md and ARCHITECTURE.md.

---

### Phase 2: OpenCodeAgent + CI Integration

**Rationale:** OpenCodeAgent depends on Phase 1 proving the Ollama model and tool-calling configuration work correctly. The working OllamaToolAgent baseline provides a comparison point and a fallback if opencode proves unstable. CI integration can only be proven after at least one agent path completes tasks end-to-end.

**Delivers:** `--agent=opencode` working in CI on ubuntu-24.04-arm. `setup-opencode` composite action. opencode.json config generation. Structured JSON output parsing from opencode for richer session logs and accurate token counts.

**Addresses (from FEATURES.md P1+P2):**
- `OpenCodeAgent` class (writes opencode.json, invokes `opencode run -q`)
- opencode Ollama provider config injection into workspace
- Non-interactive auto-approve (`"permission": { "*": "allow" }`)
- `--agent=opencode` CLI flag
- `.opencode/skills/` skill injection path added to both `LocalProvider` and `DockerProvider`
- CI integration: `setup-opencode` composite action, `OPENCODE_CONFIG_DIR` scoped to workspace
- `--format json` output parsing for structured event capture
- Agent efficiency metrics (tool call count, types, steps-to-completion)
- Model warmup for agent model

**Avoids (from PITFALLS.md):**
- Pitfall 2: External kill timer on `opencode run` subprocess; stderr monitoring for error patterns
- Pitfall 5: `OPENCODE_CONFIG_DIR` set to workspace-local path in CI; ALL fields explicit in opencode.json
- Performance trap: `OPENCODE_DISABLE_AUTOUPDATE=true` in CI; `--quiet` flag always passed
- Integration gotcha: opencode runs on host, Docker is workspace isolation only

**Research flags:** MEDIUM -- opencode linux-arm64 binary stability (issue #13367) is the critical unknown. Before writing the CI job, verify whether v1.2.23 runs without SIGABRT on ubuntu-24.04-arm. If unresolved, the CI workflow must use `--agent=ollama` only. Also verify that `--format json` does not trigger issue #2923 when used with positional prompt argument (not `--command` flag).

---

### Phase 3: Robustness, Metrics, and Advanced Features

**Rationale:** Advanced features (skills efficacy measurement, multi-model comparison, warm-start server mode) require both agent paths working reliably and the agent demonstrably completing tasks. Cannot measure skills delta or tool efficiency if the agent cannot complete tasks at all.

**Delivers:** Production-ready CI pipeline with memory budget validation, skills delta measurement (`--compare-skills`), and multi-model convenience flag (`--models=a,b,c`).

**Addresses (from FEATURES.md P3):**
- `--compare-skills` mode: run both vanilla and with-skills variants, report delta
- `--models=a,b,c` multi-model comparison convenience flag
- `ollama launch opencode --config` auto-discovery for zero-config local setup
- Warm-start server mode (`opencode serve` + `opencode run --attach`) -- only if per-trial overhead is a measured bottleneck
- Memory budget validation: CI step runs `free -m` before and after eval, documents peak usage under 14 GB

**Avoids (from PITFALLS.md):**
- Technical debt: grader timeout separated from agent timeout in `task.toml` (`grader.timeout_sec`)
- UX pitfall: progress indicator streaming opencode JSON events during agent execution

**Research flags:** LOW -- these are straightforward extensions of working Phase 1-2 infrastructure. Skills delta is already supported via `--no-skills` flag; the comparison mode is a thin wrapper.

---

### Phase Ordering Rationale

- **OllamaToolAgent before OpenCodeAgent:** opencode has known platform instability on both target platforms. Building the CLI-independent path first means development is never blocked by opencode binary issues. The working direct-Ollama baseline also creates a comparison point for opencode results and a production fallback if opencode remains unstable.

- **Tool-calling smoke test in Phase 1, not Phase 2:** The smoke test (assert `tool_calls` in API response) must gate Phase 1 because a silent tool-call failure looks identical to a model capability failure. Discovering this in Phase 2 CI adds days of debugging.

- **Local validation before CI integration:** Phase 2 CI work depends on Phase 1 proving the Ollama model and tool-calling configuration. CI integration on a broken configuration produces opaque failures that are harder to debug than local failures.

- **Advanced features last:** Skills efficacy measurement, multi-model comparison, and warm-start server mode all require a reliably working agent. PROJECT.md explicitly defers these to after basic task completion is proven.

### Research Flags

**Needs research-phase during planning:**
- **Phase 2 (OpenCodeAgent CI):** opencode linux-arm64 SIGABRT (issue #13367) -- verify resolution status for current release. Binary go/no-go question best answered by actually running the binary on ubuntu-24.04-arm. If unresolved, CI must use `--agent=ollama`.
- **Phase 2 (JSON output parsing):** Verify issue #2923 does not affect the `opencode run <prompt>` (positional argument) invocation pattern before implementing the JSON parser.

**Standard patterns (skip research-phase):**
- **Phase 1 (OllamaToolAgent):** Ollama tool-calling API is fully documented with verified TypeScript examples in STACK.md and ARCHITECTURE.md.
- **Phase 1 (Modelfile context window):** Exact commands documented and verified in PITFALLS.md and STACK.md. No unknowns.
- **Phase 3 (skills delta, multi-model):** Thin wrappers over working Phase 1-2 infrastructure.

## Confidence Assessment

| Area | Confidence | Notes |
|------|------------|-------|
| Stack | HIGH | All technology choices verified via official docs and GitHub issues. Platform constraints confirmed via 4 separate GitHub issues. RAM estimates cross-validated across 3 sources. Ollama version pinning derived from release notes. |
| Features | MEDIUM-HIGH | P1 features are well-scoped from existing codebase patterns. P2/P3 features are reasonable inferences from research; complexity estimates untested against actual opencode output format. |
| Architecture | HIGH | Build order and component boundaries are clear. Existing codebase (`BaseAgent`, providers, graders) is well-understood from the codebase map. New components follow established patterns exactly. |
| Pitfalls | HIGH | All 6 critical pitfalls sourced from verified GitHub issues and official docs with specific issue numbers. These are directly reported failure modes, not inferred risks. |

**Overall confidence:** HIGH

### Gaps to Address

- **opencode linux-arm64 SIGABRT (issue #13367) resolution status:** At research time (2026-03-10), this issue was open. Must verify during Phase 2 planning. If unresolved, CI must use `--agent=ollama` only and the `--agent=opencode` CI job must be gated.

- **qwen3.5:9b Ollama registry availability:** FEATURES.md recommends qwen3.5:9b as the aspirational best-quality agent model but notes availability on ollama.com/library should be verified at implementation time.

- **OllamaToolAgent tool-calling reliability at 8B scale:** Community consensus favors 14B+ models for reliable tool calling. qwen3:8b has native tool-call training but this advantage has not been validated against the specific `superlint_demo` task. The Phase 1 smoke test will resolve this gap.

- **`opencode run --file` vs prompt-as-argument:** PITFALLS.md recommends a `--file` flag to avoid shell escaping issues with special characters in instructions. Verify this flag exists in opencode v1.2.23 before implementing; if absent, the base64-encode-to-tempfile pattern (from existing agents) is the fallback.

## Sources

### Primary (HIGH confidence)
- [OpenCode CLI Docs](https://opencode.ai/docs/cli/) -- run command, flags, non-interactive mode
- [OpenCode Config Docs](https://opencode.ai/docs/config/) -- layered config system, precedence rules
- [OpenCode Permissions Docs](https://opencode.ai/docs/permissions/) -- permission model, auto-approval
- [OpenCode Providers Docs](https://opencode.ai/docs/providers/) -- Ollama provider configuration format
- [Ollama OpenCode Integration Docs](https://docs.ollama.com/integrations/opencode) -- official setup, recommended models
- [Ollama Tool Calling Docs](https://docs.ollama.com/capabilities/tool-calling) -- API format, supported models, agentic loops
- [Ollama FAQ](https://docs.ollama.com/faq) -- default context, keep-alive, concurrent models
- [Qwen3 Official GitHub](https://github.com/QwenLM/Qwen3) -- model capabilities, tool calling
- [ollama/ollama-js GitHub](https://github.com/ollama/ollama-js) -- official JS client, TypeScript types

### Secondary (MEDIUM confidence)
- [OpenCode #4340](https://github.com/anomalyco/opencode/issues/4340) -- Windows ARM64 not supported (open issue)
- [OpenCode #13367](https://github.com/anomalyco/opencode/issues/13367) -- linux-arm64 SIGABRT crash (open issue)
- [OpenCode #8203](https://github.com/anomalyco/opencode/issues/8203) -- run hangs on errors (confirmed bug)
- [OpenCode #7486](https://github.com/anomalyco/opencode/issues/7486) -- tool calls as text with local LLMs
- [OpenCode #5888](https://github.com/anomalyco/opencode/issues/5888) -- CI hangs waiting for input
- [OpenCode #10411](https://github.com/anomalyco/opencode/issues/10411) -- non-interactive mode feature request
- [Ollama GitHub Releases](https://github.com/ollama/ollama/releases) -- Qwen 3/3.5 tool call parser fixes in v0.17.3-v0.17.7
- [Ollama VRAM Requirements Guide 2026](https://localllm.in/blog/ollama-vram-requirements-for-local-llms) -- RAM estimation per quantization
- [Qwen3 8B specs](https://apxml.com/models/qwen3-8b) -- model parameters and memory
- [p-lemonish/ollama-x-opencode](https://github.com/p-lemonish/ollama-x-opencode) -- context window fix, tool calling config
- [SkillsBench: Benchmarking Agent Skills (arxiv 2602.12670)](https://arxiv.org/html/2602.12670v1) -- skills efficacy measurement methodology

### Tertiary (LOW confidence)
- [Best Ollama Models for Tool Calling 2026](https://clawdbook.org/blog/openclaw-best-ollama-models-2026) -- model comparison (community blog)
- [Qwen3.5 9B Coverage (VentureBeat)](https://venturebeat.com/technology/alibabas-small-open-source-qwen3-5-9b-beats-openais-gpt-oss-120b-and-can-run) -- model capabilities (validate availability at implementation time)

---
*Research completed: 2026-03-10*
*Ready for roadmap: yes*
