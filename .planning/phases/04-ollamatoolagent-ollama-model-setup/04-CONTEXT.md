# Phase 4: OllamaToolAgent + Ollama Model Setup - Context

**Gathered:** 2026-03-10
**Status:** Ready for planning

<domain>
## Phase Boundary

Prove a local Ollama model can complete agent tasks via direct API tool calling. Delivers OllamaToolAgent class, `--agent=ollama` CLI flag, custom Modelfile, tool-calling smoke test, sequential model loading, and superlint_demo completion. Does NOT include opencode integration (Phase 5), CI setup (Phase 6), or performance comparison (Phase 7).

</domain>

<decisions>
## Implementation Decisions

### Tool set design
- Four tools: `read_file`, `write_file`, `bash`, `list_directory` (snake_case naming)
- Bash runs unrestricted within the provider sandbox (Docker container or LocalProvider temp dir)
- File tools (`read_file`, `write_file`, `list_directory`) are path-scoped to the workspace root -- reject any resolved path outside the workspace boundary (path traversal defense)
- Three-tier permission model:
  1. **Built-in secure denylist** (hardcoded, immutable) -- dangerous bash patterns that can never be overridden. Researcher to investigate secure bash command denylist for AI agents.
  2. **OllamaAgent defaults** -- sensible default allow/deny lists
  3. **task.toml overrides** -- per-task `[agent.permissions]` with allow/deny arrays, merged with agent defaults
- Permission syntax uses `bash(command *)` glob patterns (inspired by Claude Code's `Bash(pattern)` syntax in settings.json)
- Built-in secure denylist always takes precedence -- task.toml can loosen or tighten agent defaults but cannot bypass the hardcoded denylist
- `node:vm` and `@anthropic-ai/sandbox-runtime` investigated and rejected: `node:vm` only sandboxes JS execution (not shell/fs), sandbox-runtime only supports macOS/Linux (not Windows ARM64 dev machine)

### Model selection
- Primary candidate: qwen3:8b
- If qwen3:8b fails the smoke test, researcher identifies 1-2 fallback candidates (e.g., llama3.1:8b, mistral-nemo)

### Claude's Discretion
- Agent loop behavior: max iterations handling, text-to-tool-call fallback parsing, system prompt content, conversation history/context window management
- Model configuration: context window size for custom Modelfile, model unload strategy (explicit vs auto-evict)
- Smoke test gate: test scope (single tool call vs multi-step), failure behavior (abort vs retry)
- Tool output truncation limits
- Tool parameter schemas (line ranges for read_file, timeout for bash, append mode for write_file)
- Tool response format (raw text vs JSON)

</decisions>

<specifics>
## Specific Ideas

- Permission model inspired by Claude Code's `allowedTools`/`deniedTools` in `~/.claude/settings.json` with `Bash(pattern)` glob syntax
- Three-tier precedence: hardcoded secure denylist > agent defaults > task.toml overrides
- Path-scoping on file tools is a lightweight defense layer that works cross-platform without OS-level sandboxing

</specifics>

<code_context>
## Existing Code Insights

### Reusable Assets
- `BaseAgent` abstract class (`src/types.ts:76`): single `run(instruction, workspacePath, runCommand)` method -- OllamaToolAgent extends this
- `GeminiAgent`/`ClaudeAgent` (`src/agents/`): 22-line wrappers that shell out via `runCommand` -- reference pattern, but OllamaToolAgent will have internal tool-calling logic instead
- `LLMGrader` Ollama integration (`src/graders/index.ts`): existing HTTP calls to Ollama API at localhost:11434 -- can reference for connection patterns
- `CommandResult` type (`src/types.ts:1`): `{ stdout, stderr, exitCode }` -- tool responses will use this
- `withTimeout` in `src/evalRunner.ts`: existing timeout wrapper for agent runs

### Established Patterns
- Agent receives `runCommand` callback that executes commands inside the provider's workspace and logs them to session_log
- Provider handles workspace lifecycle (prepare/setup/cleanup/teardown)
- CLI argument parsing in `src/cli.ts:59`: `--agent=gemini|claude` pattern -- extend with `--agent=ollama`
- Sequential model loading is a project constraint (16GB RAM) -- agent model must be unloaded before grader loads

### Integration Points
- `src/cli.ts:187`: agent selection switch -- add `ollama` case alongside `gemini` and `claude`
- `src/providers/local.ts` and `src/providers/docker.ts`: provide `runCommand` callback that OllamaToolAgent's bash tool will delegate to
- Ollama API at localhost:11434 -- same server used by LLMGrader but with a different model (agent: qwen3:8b, grader: qwen2.5:3b)
- `task.toml` config: new `[agent.permissions]` section for allow/deny lists

</code_context>

<deferred>
## Deferred Ideas

- `@anthropic-ai/sandbox-runtime` integration for Linux-only OS-level sandboxing -- could be added as optional layer in a future phase
- Configurable tool set per task (beyond permissions -- actually different tools) -- not needed for Phase 4
- MCP-style tool definitions -- current snake_case function tools are sufficient

</deferred>

---

*Phase: 04-ollamatoolagent-ollama-model-setup*
*Context gathered: 2026-03-10*
