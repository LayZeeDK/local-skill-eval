# Codebase Structure

**Analysis Date:** 2026-03-10

## Directory Layout

```
local-skill-eval/
├── src/                    # All TypeScript source code
│   ├── cli.ts              # Main entry point — eval runner CLI
│   ├── evalRunner.ts       # Core orchestration: EvalRunner class
│   ├── types.ts            # Shared interfaces and abstract classes
│   ├── preview.ts          # Preview entry point (routes CLI vs browser)
│   ├── viewer.ts           # Standalone browser viewer (legacy; see reporters/browser.ts)
│   ├── viewer.html         # Single-file browser UI served by browser reporter
│   ├── agents/             # Agent harness implementations
│   │   ├── claude.ts       # ClaudeAgent — wraps `claude` CLI
│   │   └── gemini.ts       # GeminiAgent — wraps `gemini` CLI
│   ├── graders/            # Grader implementations
│   │   └── index.ts        # DeterministicGrader, LLMGrader, getGrader factory
│   ├── providers/          # Environment provider implementations
│   │   ├── docker.ts       # DockerProvider — containerized isolation
│   │   └── local.ts        # LocalProvider — temp dir on host
│   ├── reporters/          # Output formatters
│   │   ├── cli.ts          # ANSI terminal report
│   │   └── browser.ts      # HTTP server + viewer.html
│   └── analytics/          # Post-run analysis
│       ├── analyze.ts      # Analytics CLI entry point
│       └── engine.ts       # AnalyticsEngine + calculateNormalizedGain
├── tasks/                  # Eval task definitions (one dir per task)
│   └── superlint_demo/     # Example task
│       ├── task.toml       # Task config: graders, timeouts, resource limits
│       ├── instruction.md  # Agent prompt
│       ├── app.js          # Task workspace file(s)
│       ├── environment/    # Container setup
│       │   └── Dockerfile  # Task Docker image
│       ├── solution/       # Reference solution for --validate
│       │   └── solve.sh
│       ├── tests/          # Deterministic grader scripts
│       │   └── test.sh
│       ├── prompts/        # LLM rubric files
│       │   └── quality.md
│       ├── skills/         # Co-located skills (auto-injected)
│       │   └── superlint/
│       │       └── SKILL.md
│       └── bin/            # Task-specific CLI tools available on PATH
├── suites/                 # Task groupings for batch runs
│   └── workflow.toml       # Defines a named list of task names
├── tests/                  # Integration and unit test scripts
│   ├── bootstrap.test.ts   # End-to-end: full eval pipeline (local + docker)
│   ├── analytics.test.ts   # Analytics engine unit tests
│   ├── ollama-grader.test.ts  # LLMGrader with mocked fetch
│   ├── docker-cache.test.ts   # Docker image cache behavior
│   ├── local-provider.test.ts # LocalProvider unit tests
│   ├── benchmark-grader.ts    # Grader accuracy/latency benchmark
│   └── fixtures/           # Static test fixtures
│       └── benchmark/
│           ├── session-empty.json
│           ├── session-positive.json
│           └── session-wrong.json
├── results/                # Eval report output (JSON, gitignored)
│   └── <task>_<timestamp>.json
├── scripts/                # Development/CI helper scripts
│   └── ollama-bench.sh     # Shell benchmark for Ollama performance tuning
├── research/               # Exploratory research artifacts
│   └── skill-creator/
├── assets/                 # Static assets (images for README)
│   └── cli-preview.png
├── dist/                   # TypeScript compilation output (gitignored)
├── .planning/              # GSD project planning documents
├── .github/                # CI/CD workflows and reusable actions
│   ├── workflows/
│   └── actions/
│       ├── setup-node/
│       └── setup-ollama/
├── package.json            # npm manifest, scripts, dependencies
├── tsconfig.json           # TypeScript compiler config (target ES2024, CommonJS)
├── .node-version           # Node.js version pin (for FNM/nvm)
└── README.md
```

## Directory Purposes

**`src/`:**
- Purpose: All TypeScript application code
- Contains: Entry points, orchestration, plugins (agents/providers/graders), reporters, analytics
- Key files: `src/cli.ts` (main entry), `src/evalRunner.ts` (orchestrator), `src/types.ts` (data model)

**`src/agents/`:**
- Purpose: One file per supported AI agent CLI
- Contains: Classes extending `BaseAgent`; each wraps a specific CLI tool (gemini, claude)
- Key files: `src/agents/gemini.ts`, `src/agents/claude.ts`

**`src/providers/`:**
- Purpose: Environment isolation strategies
- Contains: Classes implementing `EnvironmentProvider`; one for Docker, one for local process
- Key files: `src/providers/docker.ts`, `src/providers/local.ts`

**`src/graders/`:**
- Purpose: Task scoring implementations
- Contains: `Grader` interface, `DeterministicGrader`, `LLMGrader`, `getGrader` factory
- Key files: `src/graders/index.ts` (single file — all graders in one module)

**`src/reporters/`:**
- Purpose: Human-readable output of eval results
- Contains: CLI ANSI formatter, HTTP server for browser UI
- Key files: `src/reporters/cli.ts`, `src/reporters/browser.ts`

**`src/analytics/`:**
- Purpose: Cross-run statistical analysis
- Contains: `AnalyticsEngine` class, `calculateNormalizedGain` function
- Key files: `src/analytics/engine.ts`, `src/analytics/analyze.ts`

**`tasks/`:**
- Purpose: Self-contained task definitions — each task is a directory with `task.toml`, `instruction.md`, grader scripts, a Dockerfile, and optional skills
- Contains: One subdirectory per eval task
- Key files: `tasks/<name>/task.toml`, `tasks/<name>/instruction.md`, `tasks/<name>/environment/Dockerfile`

**`suites/`:**
- Purpose: Named collections of tasks for batch evaluation
- Contains: TOML files listing task names
- Key files: `suites/workflow.toml`

**`tests/`:**
- Purpose: Integration and unit tests; run with `ts-node` directly (no test framework)
- Contains: `*.test.ts` files and `benchmark-grader.ts`, plus fixture JSON files
- Key files: `tests/bootstrap.test.ts` (full pipeline smoke test), `tests/ollama-grader.test.ts` (LLM grader unit tests)

**`tests/fixtures/benchmark/`:**
- Purpose: Static session log JSON files used by grader benchmark and unit tests
- Generated: No — manually authored
- Committed: Yes

**`results/`:**
- Purpose: Output directory for eval reports — one JSON file per eval run
- Generated: Yes — written by `EvalRunner.saveReport()`
- Committed: No (gitignored)

**`scripts/`:**
- Purpose: Developer utilities not part of the application
- Contains: Shell scripts for benchmarking and tooling
- Key files: `scripts/ollama-bench.sh`

**`dist/`:**
- Purpose: TypeScript compilation output
- Generated: Yes — `tsc` writes here
- Committed: No (gitignored)

## Key File Locations

**Entry Points:**
- `src/cli.ts`: Main eval CLI — invoked by `npm run eval`
- `src/preview.ts`: Results viewer router — invoked by `npm run preview`
- `src/analytics/analyze.ts`: Analytics CLI — invoked by `npm run analyze`

**Configuration:**
- `tasks/<name>/task.toml`: Per-task configuration — grader types, weights, timeouts, resource limits
- `suites/<name>.toml`: Suite configuration — list of task names
- `tsconfig.json`: TypeScript compiler settings
- `package.json`: npm scripts and dependencies
- `.node-version`: Node.js version requirement (24+)

**Core Logic:**
- `src/evalRunner.ts`: Trial execution, grader dispatch, metric calculation, report persistence
- `src/types.ts`: All shared interfaces and abstract classes
- `src/graders/index.ts`: All grader logic including Ollama/Gemini/Anthropic LLM calls

**Testing:**
- `tests/bootstrap.test.ts`: Full pipeline end-to-end test (no external AI needed)
- `tests/ollama-grader.test.ts`: LLM grader unit tests with mocked HTTP
- `tests/fixtures/benchmark/*.json`: Static session fixtures for grader accuracy tests

## Naming Conventions

**Files:**
- `camelCase.ts` for source modules (e.g., `evalRunner.ts`, `docker.ts`)
- `kebab-case.test.ts` is not used; files are named `<feature>.test.ts` in flat `tests/` dir
- Task directories use `snake_case` (e.g., `superlint_demo`)
- Suite files use `snake_case.toml` (e.g., `workflow.toml`)
- Result files: `<taskName>_<ISO-timestamp>.json` (e.g., `superlint_demo_2026-03-08T13-30-48-941Z.json`)

**Classes:**
- PascalCase for classes (e.g., `EvalRunner`, `DockerProvider`, `LLMGrader`, `GeminiAgent`)
- Suffix conventions: `Provider` for environment providers, `Agent` for agent harnesses, `Grader` for graders, `Reporter` is not used (files are named by output mode: `cli.ts`, `browser.ts`)

**Interfaces:**
- PascalCase prefixed by role (e.g., `EnvironmentProvider`, `GraderConfig`, `TaskConfig`, `TrialResult`)
- No `I` prefix convention

**Functions:**
- `camelCase` for exported functions (e.g., `loadTaskConfig`, `getGrader`, `calculatePassAtK`, `calculateNormalizedGain`)
- `camelCase` for private methods (e.g., `runSingleTrial`, `saveReport`, `sanitize`)

## Where to Add New Code

**New Agent (e.g., OpenAI CLI harness):**
- Implementation: `src/agents/<agentname>.ts` — extend `BaseAgent`
- Wire up: add to agent selection in `src/cli.ts`

**New Environment Provider:**
- Implementation: `src/providers/<name>.ts` — implement `EnvironmentProvider`
- Wire up: add to provider selection in `src/cli.ts`

**New Grader Type:**
- Implementation: add class to `src/graders/index.ts` implementing `Grader`
- Wire up: add case to `getGrader()` switch in `src/graders/index.ts`
- Reference in task: add `[[graders]]` entry in `task.toml` with the new `type` string

**New Task:**
- Create directory: `tasks/<task_name>/`
- Required files: `task.toml`, `instruction.md`, `environment/Dockerfile`, `tests/test.sh` (or other grader command), `solution/solve.sh`
- Optional: `prompts/<rubric>.md` for LLM graders, `skills/<skill>/SKILL.md` for auto-discovered skills, `.env` for task-specific env vars

**New Reporter:**
- Implementation: `src/reporters/<mode>.ts` exporting a `run<Mode>Preview(resultsDir)` function
- Wire up: add branch in `src/preview.ts`

**New Analytics Metric:**
- Add computation to `src/analytics/engine.ts` in `AnalyticsEngine.aggregate()` or as a standalone exported function
- Expose in output in `src/analytics/analyze.ts`

**New Test:**
- Location: `tests/<feature>.test.ts`
- Pattern: self-contained script using `ts-node`; call `process.exit(1)` on failure
- Add `npm run test:<feature>` script to `package.json`

## Special Directories

**`.planning/`:**
- Purpose: GSD workflow planning documents (phases, milestones, codebase analysis)
- Generated: Partially (phase docs are generated; codebase docs written by mapping agents)
- Committed: Yes

**`results/`:**
- Purpose: Eval report output; one timestamped JSON per eval run
- Generated: Yes — runtime output
- Committed: No (in `.gitignore`)

**`dist/`:**
- Purpose: TypeScript compilation output
- Generated: Yes — `npm run build`
- Committed: No (in `.gitignore`)

**`tasks/<name>/bin/`:**
- Purpose: Task-specific CLI executables available on PATH during agent execution; LocalProvider prepends `$(pwd)/bin` to PATH via shell wrapper; Docker image can install these during `Dockerfile` build
- Generated: No — part of the task definition
- Committed: Yes

---

*Structure analysis: 2026-03-10*
