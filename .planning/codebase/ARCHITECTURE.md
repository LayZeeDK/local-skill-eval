# Architecture

**Analysis Date:** 2026-03-10

## Pattern Overview

**Overall:** Plugin-based evaluation pipeline with provider/agent/grader abstractions

**Key Characteristics:**
- Interface-driven extensibility: `BaseAgent` (abstract class), `EnvironmentProvider` (interface), `Grader` (interface) are all independently swappable
- Three-phase lifecycle per eval run: one-time `prepare` → per-trial `setup`/`cleanup` → one-time `teardown`
- Functional core: pure data types in `src/types.ts`; side-effecting orchestration in `src/evalRunner.ts`
- No external framework — plain Node.js with `ts-node` for execution

## Layers

**CLI Entry Point:**
- Purpose: Parse CLI arguments, load env files, dispatch to `EvalRunner`
- Location: `src/cli.ts`
- Contains: Argument parsing, `.env` loading, task/suite resolution, result printing
- Depends on: `EvalRunner`, `DockerProvider`, `LocalProvider`, `GeminiAgent`, `ClaudeAgent`
- Used by: `npm run eval`, `npm run validate`

**Eval Runner (Orchestrator):**
- Purpose: Execute one or more trials of a task, aggregate results, save reports
- Location: `src/evalRunner.ts`
- Contains: `EvalRunner` class, `loadTaskConfig`, `withTimeout`, `calculatePassAtK`, `calculatePassPowK`, secret sanitization, report persistence
- Depends on: `EnvironmentProvider`, `BaseAgent`, graders, `src/types.ts`
- Used by: `src/cli.ts`, test files

**Environment Providers:**
- Purpose: Manage isolated workspaces where the agent runs — either Docker containers or local temp dirs
- Location: `src/providers/docker.ts`, `src/providers/local.ts`
- Contains: Implements `EnvironmentProvider` interface — `prepare`, `setup`, `cleanup`, `teardown`, `runCommand`, `diagnose`
- Depends on: `dockerode`, `fs-extra`, `tar-stream`, Node.js `child_process`
- Used by: `EvalRunner`

**Agents:**
- Purpose: Run the AI agent CLI inside the workspace and return its output
- Location: `src/agents/gemini.ts`, `src/agents/claude.ts`
- Contains: Extends `BaseAgent` abstract class, implements `run(instruction, workspacePath, runCommand)`
- Depends on: `src/types.ts`
- Used by: `EvalRunner` via `BaseAgent` interface

**Graders:**
- Purpose: Score the agent's work after it finishes — either deterministically or via LLM
- Location: `src/graders/index.ts`
- Contains: `DeterministicGrader`, `LLMGrader`, `getGrader` factory function, `Grader` interface
- Depends on: `src/types.ts`, Ollama/Gemini/Anthropic HTTP APIs
- Used by: `EvalRunner` per-trial, after agent completion

**Analytics:**
- Purpose: Compute Normalized Gain and aggregate statistics across multiple eval reports
- Location: `src/analytics/engine.ts`, `src/analytics/analyze.ts`
- Contains: `AnalyticsEngine`, `calculateNormalizedGain`, `AggregateStats`
- Depends on: `src/types.ts`, `fs-extra`
- Used by: `npm run analyze` via `src/analytics/analyze.ts`

**Reporters:**
- Purpose: Display eval results to the user (CLI pretty-print or browser web UI)
- Location: `src/reporters/cli.ts`, `src/reporters/browser.ts`
- Contains: ANSI-colored terminal output, minimal HTTP server serving `src/viewer.html`
- Depends on: `fs-extra`, Node.js `http`
- Used by: `src/preview.ts`

**Shared Types:**
- Purpose: Define the data model shared across all layers
- Location: `src/types.ts`
- Contains: `CommandResult`, `TaskConfig`, `GraderConfig`, `GraderResult`, `LogEntry`, `TrialResult`, `EvalReport`, `BaseAgent` (abstract class), `EnvironmentProvider` (interface)
- Depends on: Nothing
- Used by: All other modules

## Data Flow

**Normal Eval Run:**

1. `src/cli.ts` parses CLI args, loads root `.env` and task `.env`, resolves task directory
2. `cli.ts` auto-discovers skills in `tasks/<name>/skills/` and builds `skillsPaths[]`
3. `cli.ts` constructs a provider (`DockerProvider` or `LocalProvider`) and an agent (`GeminiAgent` or `ClaudeAgent`)
4. `EvalRunner.runEval()` calls `provider.prepare()` once — Docker builds image, injects skills; Local is a no-op
5. For each trial: `provider.setup()` creates an isolated workspace (Docker container ID or temp dir path)
6. `EvalRunner` reads `tasks/<name>/instruction.md` and passes it to `agent.run()` with a `loggedRunCommand` callback
7. Agent invokes the real CLI tool (gemini/claude) inside the workspace via `provider.runCommand()`; each command is logged to `session_log`
8. After the agent completes, each grader from `task.toml` runs: `DeterministicGrader` executes a shell command; `LLMGrader` sends the session transcript to Ollama/Gemini/Anthropic
9. Weighted reward is calculated: `sum(score * weight) / sum(weight)`
10. `provider.cleanup()` removes the container or temp dir
11. After all trials: `provider.teardown()` clears image reference; report saved as `results/<task>_<timestamp>.json` with secrets redacted

**Validation Mode (`--validate`):**

1. Same setup, but the agent is replaced with an inline shim that runs `bash solution/solve.sh`
2. Runs 1 trial; prints grader results; exits non-zero if `reward < 0.5`

**Analytics Flow:**

1. `src/analytics/analyze.ts` reads all `*.json` files from `results/`
2. `AnalyticsEngine.aggregate()` groups reports by task name, splits into with-skill vs without-skill buckets
3. Computes `normalizedGain = (passRateWithSkill - passRateNoSkill) / (1 - passRateNoSkill)`

**State Management:**
- No in-memory global state across runs
- `DockerProvider` holds `preparedImage` string as instance state during a single eval run
- All persistent state lives in `results/*.json` (append-only log)

## Key Abstractions

**BaseAgent (`src/types.ts`):**
- Purpose: Contract for any AI agent CLI harness
- Examples: `src/agents/gemini.ts`, `src/agents/claude.ts`
- Pattern: Abstract class with single `run(instruction, workspacePath, runCommand)` method; receives a `runCommand` callback so commands are logged transparently

**EnvironmentProvider (`src/types.ts`):**
- Purpose: Isolate the filesystem/process environment that the agent operates in
- Examples: `src/providers/docker.ts`, `src/providers/local.ts`
- Pattern: Two-phase lifecycle — `prepare`/`teardown` (one-time) and `setup`/`cleanup` (per-trial); `runCommand` executes shell commands inside the workspace

**Grader (`src/graders/index.ts`):**
- Purpose: Score a completed agent session on a 0.0–1.0 scale
- Examples: `DeterministicGrader` (shell exit code + optional `reward.txt`), `LLMGrader` (Ollama → Gemini → Anthropic fallback chain)
- Pattern: `grade(workspace, provider, config, taskPath, sessionLog, env)` returns a `GraderResult`

**TaskConfig (`src/types.ts`):**
- Purpose: Typed representation of `task.toml`; defines graders, timeouts, resource limits
- Pattern: Loaded by `loadTaskConfig()` in `src/evalRunner.ts`; supports both `[[graders]]` format and legacy `[verifier]` format

**EvalReport (`src/types.ts`):**
- Purpose: Serializable output of an entire eval run (all trials, metrics, session logs)
- Pattern: Written to `results/<task>_<timestamp>.json`; loaded by analytics and reporters

## Entry Points

**Main Eval CLI:**
- Location: `src/cli.ts`
- Triggers: `npm run eval`, `ts-node src/cli.ts`
- Responsibilities: Full eval orchestration — provider selection, skill discovery, env loading, trial execution, result display

**Analytics CLI:**
- Location: `src/analytics/analyze.ts`
- Triggers: `npm run analyze`
- Responsibilities: Load all result JSON files, compute normalized gain, print summary table

**Preview CLI:**
- Location: `src/preview.ts`
- Triggers: `npm run preview`, `npm run viewer`
- Responsibilities: Route to CLI reporter or browser HTTP server based on first argument

**Test Runner Scripts:**
- Location: `tests/*.test.ts`, `tests/benchmark-grader.ts`
- Triggers: `npm run test:*` scripts
- Responsibilities: Self-contained integration/unit test scripts (no Jest/Vitest; use `process.exit(1)` on failure)

## Error Handling

**Strategy:** Errors propagate up to the caller; `EvalRunner.runSingleTrial` catches all errors and returns `reward: 0` with the error message in the session log; `cli.ts` catches top-level errors and calls `process.exit(1)`

**Patterns:**
- Trial-level catch: any error in `runSingleTrial` produces a zero-reward trial, not a thrown exception, so other trials continue
- Provider diagnose: `DockerProvider.diagnose()` collects container state (ps, memory, disk) when a trial fails — useful for debugging Docker hangs
- LLM grader fallback: Ollama → Gemini → Anthropic; returns a zero-score `GraderResult` with an error message if all fail
- Timeout wrapper: `withTimeout()` rejects after `taskConfig.agent.timeout_sec` seconds

## Cross-Cutting Concerns

**Secret Redaction:** `EvalRunner.sanitize()` replaces all env var values (≥6 chars) with `[REDACTED]` in `session_log` before writing to disk; applied in `saveReport()`

**Skill Injection:** Both providers copy skill directories into `.agents/skills/` (Gemini) and `.claude/skills/` (Claude) inside the workspace; this is handled in `provider.setup()` (LocalProvider) and `provider.prepare()` (DockerProvider via container commit)

**Content Hashing:** `DockerProvider` computes a SHA-256 content hash of the task directory and skills to produce deterministic Docker image names; cache hit avoids rebuild (`src/providers/docker.ts` → `computeContextHash`)

**Logging:** `console.log`/`console.warn`/`console.error` throughout; no structured logging framework; all agent session events written to `session_log: LogEntry[]` in the report JSON

---

*Architecture analysis: 2026-03-10*
