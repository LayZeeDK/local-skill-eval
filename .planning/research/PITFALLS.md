# Pitfalls Research

**Domain:** Adding opencode CLI + Ollama agent backend to existing skill-eval framework
**Researched:** 2026-03-10
**Confidence:** HIGH

## Critical Pitfalls

### Pitfall 1: Ollama Default 4K Context Window Silently Breaks opencode Tool Calling

**What goes wrong:**
Ollama defaults to a 4,096-token context window for all models, regardless of the model's advertised capacity. opencode's agentic workflow -- tool definitions, system prompt, conversation history, tool call results -- easily exceeds 4K tokens within the first few exchanges. When context is exhausted, the model loses track of available tools and either stops calling them (producing text-only output) or emits malformed tool calls that opencode cannot parse. The agent appears to "think about" what to do but never actually does it.

**Why it happens:**
Ollama intentionally caps `num_ctx` at 4096 for memory safety. Models like qwen3:8b advertise 40K+ context, but Ollama ignores the model's native capacity unless explicitly overridden. opencode connects via the OpenAI-compatible `/v1` endpoint and does not set `num_ctx` in its requests -- it assumes the server provides adequate context. This silent mismatch is the single most common failure mode reported by opencode+Ollama users.

**How to avoid:**
1. Create a custom Ollama model variant with expanded context: `ollama run qwen3:8b` then `/set parameter num_ctx 16384` then `/save qwen3:8b-16k`. Use the new model name in opencode config.
2. Alternatively, set `OLLAMA_CONTEXT_LENGTH=16384` as an environment variable before starting `ollama serve` to set the default for all models.
3. For CI, set this in the `setup-ollama` composite action alongside the existing `OLLAMA_FLASH_ATTENTION` and `OLLAMA_KV_CACHE_TYPE` vars.
4. Do NOT jump to 64K context -- on 16GB RAM with a Q4 8B model, 16K context with q8_0 KV cache uses ~6-7GB total (weights + KV), leaving room for OS, Node.js, Docker, and opencode itself. 32K is the ceiling; 64K will OOM on the CI runner.
5. Always verify effective context with `ollama ps` after loading -- the "context" column shows actual allocated context, not the model's advertised max.

**Warning signs:**
- Agent produces text output describing what it would do, but `n_commands: 0` in trial results
- opencode logs show tool calls being emitted but no tool results returning
- Agent loops repeating the same reasoning without progress (context too small for conversation history)
- `ollama ps` shows a loaded model with context size 4096 when you expected more

**Phase to address:**
Phase 1 (opencode+Ollama configuration). This must be validated before any agent evaluation work begins. A pre-flight check should confirm effective context window size.

---

### Pitfall 2: opencode `run` Hangs Indefinitely on Errors Instead of Exiting

**What goes wrong:**
When `opencode run` encounters an API error (HTTP 429 rate limit, connection refused, model not found, or any unrecoverable error), it logs the error but never exits -- the process hangs indefinitely. In the skill-eval framework, the `BaseAgent.run()` method spawns opencode as a subprocess. If opencode hangs, the agent timeout fires, but the subprocess may not be properly killed, leaving zombie processes that hold Ollama connections and memory.

This is a known bug: [GitHub issue #8203](https://github.com/anomalyco/opencode/issues/8203). When rate-limited, `timeout 30 opencode run "what is 1+1"` returns exit code 124 (timeout from the `timeout` wrapper), not a meaningful opencode exit code.

**Why it happens:**
opencode's `run` command was designed primarily for interactive terminal use. The error handling path logs to stderr but does not call `process.exit()` for all error types. The non-interactive mode (`run` subcommand) was added later and inherits this behavior. There is an open feature request ([#10411](https://github.com/anomalyco/opencode/issues/10411)) to add proper non-TTY detection and exit-on-error behavior.

**How to avoid:**
1. Always wrap `opencode run` invocations with an external timeout. In the `OpenCodeAgent.run()` implementation, use Node.js `child_process.spawn` with a kill timer, not just the eval runner's `withTimeout()` (which waits for the promise but does not kill the child process).
2. Use `opencode run --quiet` to suppress the spinner, which can interfere with stdout parsing in non-TTY environments.
3. Monitor the child process's stdout/stderr for error patterns (e.g., "rate limit", "connection refused") and kill proactively rather than waiting for the full timeout.
4. After killing an opencode process, verify the Ollama connection is clean -- a hung opencode may have left a streaming request open, preventing the model from accepting new requests.
5. Set an explicit external timeout shorter than the task's `timeout_sec` to give the eval runner time to capture diagnostics.

**Warning signs:**
- CI jobs hitting the GitHub Actions 30-minute job timeout with no output
- Trial duration equals exactly `timeout_sec` (meaning the external timeout fired, not a normal completion)
- Zombie `opencode` processes visible in `ps aux` after evaluation completes
- Ollama returning 503 (overloaded) on subsequent requests because a hung connection consumes the single parallel slot

**Phase to address:**
Phase 1 (OpenCodeAgent implementation). The agent wrapper must have robust subprocess lifecycle management from day one. This is not something to "fix later."

---

### Pitfall 3: RAM Pressure from Concurrent Agent Model + Grader Model on Same Ollama Instance

**What goes wrong:**
The evaluation pipeline runs sequentially: agent executes (using e.g., qwen3:8b for tool calling), then grader scores (using qwen2.5:3b for structured output). Both models are served by the same Ollama instance. Ollama's default `OLLAMA_MAX_LOADED_MODELS=3` means both models stay resident in RAM simultaneously. On the 16GB CI runner: qwen3:8b at Q4_K_M with 16K context = ~6GB, qwen2.5:3b at Q4 with 8K context = ~2.5GB, plus Ollama overhead, OS, Node.js, Docker = ~3-4GB. Total: ~12-13GB. This works, barely -- but if context windows are larger, or if a third process (Docker build) runs concurrently, the system pages to swap and inference drops to near-zero tokens/sec or the OOM killer fires.

On the local dev machine (32GB), this is manageable but still a concern during Docker-based evaluations where WSL2 consumes memory.

**Why it happens:**
Ollama defaults to keeping 3 models loaded for CPU inference. The framework runs agent and grader sequentially, but Ollama does not know they are sequential -- it keeps both loaded for fast switching. The grader model (qwen2.5:3b, already validated in v1.0) loads during grading and stays resident. The agent model loads during the next trial and both coexist. Memory pressure accumulates silently because Ollama does not log warnings before hitting system limits. The OOM killer terminates Ollama without any application-level error.

**How to avoid:**
1. Set `OLLAMA_MAX_LOADED_MODELS=1` to force Ollama to unload the previous model before loading the next. This adds ~5-10 seconds of model swap time per transition but prevents OOM.
2. If both models must stay loaded, use `OLLAMA_KV_CACHE_TYPE=q8_0` (halves KV cache memory) and `OLLAMA_FLASH_ATTENTION=1` on both.
3. Use `keep_alive: "0"` in the Ollama API request for the agent model call to unload it immediately after the agent finishes, freeing RAM for the grader.
4. Use the same model for both agent and grader if possible -- then there is no model swap at all. But qwen2.5:3b (grader) is too small for agentic tool calling, and qwen3:8b (agent) was not benchmarked for grading, so this requires validation.
5. Monitor with `ollama ps` between agent and grader phases to verify memory state.
6. In CI (`setup-ollama`), set `OLLAMA_MAX_LOADED_MODELS=1` alongside the existing tuning variables.

**Warning signs:**
- Ollama process killed by OS (check `dmesg | grep -i oom` on Linux CI runner)
- Grading suddenly takes 10x longer (thrashing swap)
- Second trial fails even though first succeeded (cumulative memory pressure)
- `ollama ps` shows both models loaded with combined memory exceeding available RAM

**Phase to address:**
Phase 2 (integration of agent + grading pipeline). Must be tested end-to-end with memory monitoring before CI deployment.

---

### Pitfall 4: opencode Tool Calls Returned as Text Instead of Structured API Calls

**What goes wrong:**
Small local models (7B-8B) frequently fail to produce proper structured tool calls via the OpenAI-compatible API. Instead of returning a response with `tool_calls` in the API response body, the model emits raw XML/JSON text describing the tool invocation: `<tool_call>{"name": "bash", "arguments": {"command": "ls"}}</tool_call>`. opencode receives this as plain assistant text, not as a tool invocation, so no tool is executed. The agent appears to be working (it is generating text) but accomplishes nothing.

This is reported in [opencode issue #7486](https://github.com/anomalyco/opencode/issues/7486) and affects LM Studio, Ollama, and other local backends.

**Why it happens:**
Tool calling requires the model to output tokens in a specific format that the inference server (Ollama) can parse into structured `tool_calls` objects. Ollama has a parser for this, but it depends on the model's chat template being correctly configured. If the model was fine-tuned with a different tool-calling format than what Ollama's template expects, Ollama's parser fails to detect the tool call and passes it through as plain text. Qwen models use Hermes-style tool calling; Llama uses a different format. Mismatched templates cause silent failures.

**How to avoid:**
1. Use only models from Ollama's official "tools" category: [ollama.com/search?c=tools](https://ollama.com/search?c=tools). These have verified chat templates.
2. In opencode config, set `"tools": true` for the model explicitly: `"qwen3:8b-16k": { "name": "qwen3:8b-16k", "tools": true }`.
3. Before running evaluations, send a test prompt that requires a tool call (e.g., "list files in the current directory") and verify the response contains actual `tool_calls`, not text describing a tool call.
4. If tool calls appear as text, the model's Ollama template is wrong. Try a different model variant or update Ollama to a version that fixes the template.
5. Prefer qwen3:8b or qwen3-coder for opencode -- these have the best-tested tool calling integration per the [ollama-x-opencode guide](https://github.com/p-lemonish/ollama-x-opencode).

**Warning signs:**
- opencode session shows the model "talking about" running commands but `n_commands: 0`
- Agent output contains literal `<tool_call>` or `{"name": "bash"` text
- Model produces long reasoning text followed by zero tool executions
- Works correctly with cloud models (Anthropic, OpenAI) but fails with local models

**Phase to address:**
Phase 1 (model selection and validation). Build a tool-calling smoke test that runs before every evaluation and fails fast if the model cannot properly invoke tools.

---

### Pitfall 5: opencode Config Precedence Causes Silent Model/Permission Overrides

**What goes wrong:**
opencode has a layered config system: Remote > Global (`~/.config/opencode/opencode.json`) > Custom (`OPENCODE_CONFIG_DIR`) > Project (`opencode.json` in project root). The project-level config has highest precedence. When running skill-eval, the eval framework needs specific opencode settings (Ollama backend, specific model, all permissions auto-approved). But if the developer has a global config pointing to a cloud provider, or the project has a stale `opencode.json` from a previous experiment, those settings silently override or merge with the intended config, causing the agent to use the wrong model, wrong backend, or require interactive permission approval (which hangs in CI).

**Why it happens:**
Configs are merged, not replaced. A global config setting `"provider": {"anthropic": {...}}` does not get removed when a project config adds `"provider": {"ollama": {...}}` -- both providers exist, and model resolution may pick the wrong one. Permission settings from global config carry over unless explicitly overridden. In CI, the global config path (`~/.config/opencode/`) may contain cached state from a previous job.

**How to avoid:**
1. In CI, explicitly set `OPENCODE_CONFIG_DIR` to a known clean directory within the workspace (e.g., `.opencode/ci-config/`).
2. In the project's `opencode.json`, explicitly set ALL required fields -- do not rely on inheriting global defaults. Include model, provider, permissions, and disable autoupdate.
3. For permissions in CI, set `"permission": { "*": "allow" }` to auto-approve all tools. For local dev, use the same or set `"bash": "allow", "edit": "allow"`.
4. Add a pre-eval step that runs `opencode models --verbose` and verifies the resolved model matches expectations.
5. In the `OpenCodeAgent` implementation, pass `--model ollama/qwen3:8b-16k` explicitly on the command line to override any config-level model defaults.

**Warning signs:**
- Agent connects to Anthropic/OpenAI cloud instead of local Ollama (unexpected network requests)
- opencode prompts for permission approval and hangs (non-interactive mode but permissions not set to "allow")
- Different behavior between local dev and CI despite "same" configuration
- `opencode models` shows unexpected providers or models

**Phase to address:**
Phase 1 (opencode configuration). Create a deterministic, version-controlled config that is used in both local dev and CI, with no reliance on global state.

---

### Pitfall 6: Ollama Streaming Tool Call Parsing Bugs Across Model Families

**What goes wrong:**
Ollama has had recurring bugs where tool calls emitted by certain model families are not parsed correctly during streaming. Qwen 3 and Qwen 3.5 tool calls emitted during "thinking" mode were not parsed (fixed in v0.17.3). Qwen 3.5 had additional parsing failures (fixed in v0.17.6-v0.17.7). These bugs cause tool calls to be silently dropped -- the model correctly decides to call a tool, Ollama's parser fails to detect the tool call in the stream, and the response arrives as plain text with `finish_reason: "stop"` instead of `finish_reason: "tool_calls"`.

**Why it happens:**
Ollama's tool call parser must handle diverse model output formats: some models output tool calls inline with thinking tokens, some use XML-style tags, some use JSON. Each model family's chat template affects how tool calls appear in the raw output. Ollama's parser is continuously evolving to handle new model families, and regressions are common when new models are added.

**How to avoid:**
1. Pin Ollama version to a known-good release. As of March 2026, v0.17.7 fixes the known Qwen 3/3.5 parsing issues. Lock this in `setup-ollama/action.yml` (already parameterized as `ollama-version: '0.17.7'`).
2. Before upgrading Ollama, run the tool-calling smoke test with the specific model to verify no regressions.
3. If streaming tool calls fail, test with `stream: false` as a diagnostic. If non-streaming works but streaming does not, it is an Ollama parser bug -- file an issue and pin the working version.
4. Monitor [Ollama releases](https://github.com/ollama/ollama/releases) for tool-calling fixes in release notes before upgrading.
5. Consider using Ollama's native `/api/chat` endpoint instead of `/v1/chat/completions` if opencode supports it -- the native endpoint has more mature tool call handling.

**Warning signs:**
- Tool calls work with one model but not another on the same Ollama version
- Agent works correctly after an Ollama downgrade
- `finish_reason` is always "stop" even when the model clearly intended a tool call
- Adding `/no_think` to the prompt (disabling thinking mode) fixes tool calling

**Phase to address:**
Phase 1 (Ollama version pinning and model selection). Revisit when upgrading Ollama for any phase.

## Technical Debt Patterns

Shortcuts that seem reasonable but create long-term problems.

| Shortcut | Immediate Benefit | Long-term Cost | When Acceptable |
|----------|-------------------|----------------|-----------------|
| Hardcoding Ollama model name in agent wrapper | Quick prototype | Every model change requires code change; cannot switch models via config | Never -- use `task.toml` or opencode config from day one |
| Using same timeout for agent + grader | Simpler config | Agent tasks need 5-15 minutes; grading needs 30-120 seconds. Same timeout either kills agents prematurely or lets graders hang too long | Never -- separate timeout configs in `task.toml` (already has `agent.timeout_sec`; add `grader.timeout_sec`) |
| Skipping tool-call smoke test in CI | Faster CI pipeline | First real evaluation failure is cryptic (silent tool call drops); hours of debugging | Only during initial prototype; add to CI before v2.0 ships |
| `OLLAMA_MAX_LOADED_MODELS=3` (default) | No config needed | OOM on 16GB CI runner when agent model + grader model both resident | Never in CI -- always set to 1 |
| Ignoring opencode stderr output | Simpler output parsing | Miss error messages, rate limit warnings, model loading failures | Never -- capture and log stderr alongside stdout |
| Using `--format text` for opencode output | Human-readable logs | Cannot programmatically detect tool calls, errors, or session state | Only for manual debugging; use `--format json` for eval runner |

## Integration Gotchas

Common mistakes when connecting opencode, Ollama, and the existing eval pipeline.

| Integration | Common Mistake | Correct Approach |
|-------------|----------------|------------------|
| opencode + Ollama | Assuming model's advertised context is used | Create custom model variant with explicit `num_ctx` or set `OLLAMA_CONTEXT_LENGTH` env var |
| opencode + eval runner | Passing instruction as CLI argument (shell escaping breaks on special chars) | Write instruction to a temp file, pass as `--file` flag: `opencode run --file /tmp/instruction.md` |
| opencode + CI | Using `opencode` TUI command instead of `opencode run` | Always use `opencode run --quiet --format json` in CI; TUI hangs without TTY |
| Ollama agent + Ollama grader | Both models loaded simultaneously on 16GB | Set `OLLAMA_MAX_LOADED_MODELS=1`; accept 5-10s model swap overhead |
| opencode + Docker provider | opencode runs inside Docker container, cannot reach host Ollama | opencode must run on the host, with Ollama on the host. Docker is only for workspace isolation, not agent execution |
| opencode JSON output + subprocess | Using `readline()` to parse streaming JSON | Use newline-delimited JSON parsing with explicit buffer handling; `readline()` can hang on partial writes ([issue #11891](https://github.com/anomalyco/opencode/issues/11891)) |
| opencode permissions + CI | Relying on default "allow all" behavior | Explicitly set `"permission": { "*": "allow" }` in project opencode.json; default behavior may change between versions |
| Ollama env vars + CI | Setting `OLLAMA_FLASH_ATTENTION` etc. after `ollama serve` starts | Must set env vars BEFORE starting `ollama serve`; existing `setup-ollama` action handles this correctly |

## Performance Traps

Patterns that work at small scale but fail under evaluation workloads.

| Trap | Symptoms | Prevention | When It Breaks |
|------|----------|------------|----------------|
| opencode auto-update in CI | First CI run downloads new opencode binary, adding 30-60s latency; update changes behavior between runs | Disable with `OPENCODE_DISABLE_AUTOUPDATE=true` and pin version in CI setup | Every CI run after opencode releases an update |
| Ollama model warm-up not performed for agent | First agent trial takes 15-30s extra for model load; subsequent trials are fast | Add warm-up call for agent model, similar to existing `LLMGrader.warmUp()` | First trial of every evaluation run |
| opencode spawns subagents (tasks/multi-agent) | Subagents create additional Ollama requests, exceeding `OLLAMA_NUM_PARALLEL=1`; requests queue and timeout | Set `OLLAMA_NUM_PARALLEL=1` and ensure opencode does not use multi-agent patterns for evaluation tasks | When using opencode's Task tool or multi-agent Conductor pattern |
| Not using `--quiet` flag in CI | Spinner animation writes ANSI escape codes to stdout, corrupting JSON output parsing | Always pass `--quiet` (or `-q`) when running in non-TTY environment | Any CI run or subprocess invocation |
| Context compaction during long agent tasks | opencode compacts context mid-task, losing tool call history; model repeats earlier actions or contradicts itself | Use sufficient context window (16K+) and monitor for compaction events in JSON output | When agent task requires many tool calls (>20) |

## Security Mistakes

Domain-specific security issues for local LLM agent evaluation.

| Mistake | Risk | Prevention |
|---------|------|------------|
| opencode agent has unrestricted bash access in workspace | Agent could execute destructive commands (`rm -rf /`, install malware, exfiltrate data) outside workspace | Use Docker provider for untrusted tasks; for local provider, set opencode permissions to restrict bash to workspace directory |
| Ollama API exposed on 0.0.0.0 without auth | Any process on the network can send inference requests; no authentication by default | Bind to `127.0.0.1` only (Ollama default); in CI, this is fine; verify `OLLAMA_HOST` does not expose externally |
| API keys in opencode config committed to repo | opencode.json may contain `apiKey` fields for cloud providers during development | Add `opencode.json` to `.gitignore` if it contains secrets; use env vars for API keys, not config files |
| Agent output logged with sensitive data | If agent reads files with secrets during evaluation, those appear in session logs uploaded as CI artifacts | Existing `sanitize()` method redacts env vars; extend to also redact patterns matching API key formats |

## UX Pitfalls

Common developer experience issues in this domain.

| Pitfall | User Impact | Better Approach |
|---------|-------------|-----------------|
| No progress indicator during agent execution | Developer stares at blank terminal for 5-15 minutes wondering if it is stuck | Stream opencode JSON events and show live tool-call activity (e.g., "Running: bash ls", "Editing: src/main.ts") |
| Cryptic "model not found" when Ollama model name mismatches | Developer pulls `qwen3:8b` but opencode config says `qwen3:8b-16k` (custom variant not created) | Add pre-flight model check: verify the exact model name in opencode config exists in `ollama list` output |
| Silent fallback from local to cloud | If opencode cannot connect to Ollama, some configs may silently fall through to a cloud provider, incurring unexpected API costs | Verify Ollama connectivity before starting; if evaluating local-only, configure opencode with ONLY the Ollama provider (no cloud fallback) |
| Model download on first CI run takes 5+ minutes | CI job appears stuck during `ollama pull`; no progress shown in GitHub Actions logs | Cache Ollama models between CI runs (existing `setup-ollama` action does this with `actions/cache`) |
| Different results between local (ARM64) and CI (ARM64 Linux) | Subtle differences in FP arithmetic on different ARM64 implementations cause score variations | Use temperature=0, pin Ollama version, accept minor score variance as inherent to the platform |

## "Looks Done But Isn't" Checklist

Things that appear complete but are missing critical pieces.

- [ ] **opencode+Ollama connection:** Model loads and responds to text prompts -- but verify it actually executes tool calls (not just describes them). Send a prompt requiring `bash` tool use and check for actual command execution.
- [ ] **CI pipeline runs:** Evaluation completes on CI -- but verify the agent model was actually loaded (not skipped due to memory). Check `ollama ps` output in CI logs and verify agent model appeared.
- [ ] **Agent timeout works:** Trial hits timeout and reports failure -- but verify the opencode subprocess was actually killed. Check for zombie processes and orphaned Ollama connections.
- [ ] **JSON output parsing:** `opencode run --format json` returns JSON events -- but verify `--command` flag is not also being used, which [breaks JSON output](https://github.com/anomalyco/opencode/issues/2923).
- [ ] **Context window configured:** Custom model variant created with 16K context -- but verify `ollama ps` shows the custom variant loaded, not the base model with default 4K context.
- [ ] **Permissions auto-approved in CI:** opencode does not prompt for permission -- but verify this is because permissions are set to "allow", not because the model never attempted a tool call.
- [ ] **Model compatibility matrix:** Agent model tested and works with tool calling -- but test with the specific Ollama version pinned in CI, not just "latest". Ollama upgrades can regress tool calling.
- [ ] **Memory budget validated:** Evaluation completes locally (32GB RAM) -- but test on a 16GB-constrained environment (Docker memory limit or CI runner) to validate CI viability.

## Recovery Strategies

When pitfalls occur despite prevention, how to recover.

| Pitfall | Recovery Cost | Recovery Steps |
|---------|---------------|----------------|
| Context window too small (silent tool call failure) | LOW | Create new model variant with larger `num_ctx`; re-run evaluation. No code changes needed. |
| opencode hangs in CI | LOW | Kill the process, add external timeout wrapper, re-run. May need to restart Ollama if connection is stuck. |
| OOM from concurrent models | MEDIUM | Set `OLLAMA_MAX_LOADED_MODELS=1`, restart Ollama, re-run. May need to restart the entire CI job if OOM killed Node.js too. |
| Tool calls emitted as text | MEDIUM | Switch to a known-good model from Ollama's tools category. May require updating opencode config and re-validating. |
| opencode config precedence confusion | LOW | Delete all non-project configs (`~/.config/opencode/`), create a single clean project-level `opencode.json`, re-run. |
| Ollama version regresses tool calling | MEDIUM | Pin Ollama to previous working version in `setup-ollama/action.yml`. File upstream bug report. Potential delay if no working version exists for the desired model. |
| Agent + grader env var conflict | MEDIUM | Refactor to use separate env var namespaces. Requires code changes to `LLMGrader` to read from `GRADER_ANTHROPIC_API_KEY` etc. |
| Subagent/task timeout (opencode multi-agent) | HIGH | Redesign the opencode task to avoid multi-agent patterns. Use single-agent with explicit tool calls instead. May require rewriting AGENTS.md instructions. |

## Pitfall-to-Phase Mapping

How roadmap phases should address these pitfalls.

| Pitfall | Prevention Phase | Verification |
|---------|------------------|--------------|
| Ollama 4K default context (Pitfall 1) | Phase 1: opencode+Ollama config | `ollama ps` shows 16K+ context for loaded model; tool-calling smoke test passes |
| opencode `run` hangs on errors (Pitfall 2) | Phase 1: OpenCodeAgent implementation | Agent timeout test: force an error (wrong model name), verify subprocess exits within 30s with non-zero exit code |
| RAM pressure: agent + grader models (Pitfall 3) | Phase 2: end-to-end integration | Monitor peak memory during full eval cycle on 16GB-constrained environment; no OOM or swap thrashing |
| Tool calls as text (Pitfall 4) | Phase 1: model selection | Automated smoke test: send tool-requiring prompt, assert `tool_calls` field present in API response |
| Config precedence overrides (Pitfall 5) | Phase 1: opencode project config | CI step that runs `opencode models` and asserts only Ollama provider is configured |
| Ollama streaming parser bugs (Pitfall 6) | Phase 1: Ollama version pinning | Tool-calling smoke test with pinned Ollama version; test before any version upgrade |
| Auto-update in CI | Phase 2: CI workflow | Set `OPENCODE_DISABLE_AUTOUPDATE=true`; verify opencode version in CI logs matches pinned version |
| Subprocess lifecycle (hangs, zombies) | Phase 1: OpenCodeAgent implementation | Stress test: run 5 consecutive trials with artificial failures injected; verify no zombie processes remain |
| Memory budget in CI (16GB) | Phase 2: CI integration | CI step runs `free -m` before and after evaluation; peak usage documented and under 14GB |
| opencode permissions in CI | Phase 1: opencode project config | CI step attempts a tool call that requires permission; succeeds without interactive prompt |

## Sources

### opencode CLI
- [opencode CLI Documentation](https://opencode.ai/docs/cli/) -- `run` command, flags, non-interactive mode
- [opencode Config Documentation](https://opencode.ai/docs/config/) -- layered config system, precedence rules
- [opencode Permissions Documentation](https://opencode.ai/docs/permissions/) -- permission model, auto-approval in non-interactive mode
- [opencode GitHub: Run hangs on API errors (#8203)](https://github.com/anomalyco/opencode/issues/8203) -- confirmed bug, process never exits
- [opencode GitHub: Non-interactive mode request (#10411)](https://github.com/anomalyco/opencode/issues/10411) -- non-TTY detection gap
- [opencode GitHub: Tool calls not executed (#7486)](https://github.com/anomalyco/opencode/issues/7486) -- local LLM tool call text emission
- [opencode GitHub: JSON output with --command breaks (#2923)](https://github.com/anomalyco/opencode/issues/2923) -- format flag interaction bug
- [opencode GitHub: Subprocess hang with Popen (#11891)](https://github.com/anomalyco/opencode/issues/11891) -- readline hang on streaming JSON
- [opencode GitHub: Subagent stuck with no timeout (#11865)](https://github.com/anomalyco/opencode/issues/11865) -- multi-agent timeout gap
- [ollama-x-opencode Setup Guide](https://github.com/p-lemonish/ollama-x-opencode) -- step-by-step context window fix, tool calling config

### Ollama
- [Ollama FAQ](https://docs.ollama.com/faq) -- default context, keep-alive, concurrent models, memory management
- [Ollama Tool Calling Documentation](https://docs.ollama.com/capabilities/tool-calling) -- supported models, streaming tool calls
- [Ollama OpenCode Integration](https://docs.ollama.com/integrations/opencode) -- official config example
- [Ollama GitHub Releases](https://github.com/ollama/ollama/releases) -- Qwen 3/3.5 tool call parsing fixes in v0.17.3-v0.17.7
- [Ollama: How Parallel Requests Work](https://www.glukhov.org/llm-performance/ollama/how-ollama-handles-parallel-requests/) -- memory scaling with concurrency
- [Ollama: Debugging OOM with Multiple Models](https://vipinpg.com/blog/debugging-out-of-memory-crashes-when-running-multiple-gguf-models-simultaneously-in-ollama-with-shared-vram-pools/) -- real-world memory debugging
- [Ollama: Context Window Optimization for OpenCode](https://sebastianzehner.com/posts/ollama-context-window-optimization-opencode/) -- fixing 4K default
- [Ollama: num_ctx Misunderstanding (#2714)](https://github.com/ollama/ollama/issues/2714) -- advertised vs actual context
- [Ollama: keep_alive Issues (#5272)](https://github.com/ollama/ollama/issues/5272) -- model unloading not respecting config
- [Ollama: Preventing Model Swapping](https://blog.gopenai.com/preventing-model-swapping-in-ollama-a-guide-to-persistent-loading-f81f1dfb858d) -- persistent loading guide

### Local LLM Tool Calling
- [Ollama Tool Calling Models](https://ollama.com/search?c=tools) -- verified tool-capable models
- [Laurent Kubaski: Ollama Tool Support](https://medium.com/@laurentkubaski/ollama-tool-support-aka-function-calling-23a1c0189bee) -- small model tool calling failures
- [Best Ollama Models for Function Calling](https://collabnix.com/best-ollama-models-for-function-calling-tools-complete-guide-2025/) -- model compatibility matrix
- [Qwen Function Calling Documentation](https://qwen.readthedocs.io/en/latest/framework/function_call.html) -- Hermes-style tool use for Qwen3

### Memory and Performance
- [Ollama VRAM Requirements Guide 2026](https://localllm.in/blog/ollama-vram-requirements-for-local-llms) -- model size vs memory by quantization
- [Context Kills VRAM: KV Cache Memory](https://medium.com/@lyx_62906/context-kills-vram-how-to-run-llms-on-consumer-gpus-a785e8035632) -- ~0.110 MiB/token KV cache growth
- [Optimizing Ollama on Windows](https://medium.com/@kapildevkhatik2/optimizing-ollama-performance-on-windows-hardware-quantization-parallelism-more-fac04802288e) -- Windows-specific tuning

---
*Pitfalls research for: opencode + Ollama agent backend integration*
*Researched: 2026-03-10*
