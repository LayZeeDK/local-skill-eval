# Codebase Concerns

**Analysis Date:** 2026-03-10

## Tech Debt

**Hardcoded Ollama timeout in grader:**
- Issue: `OLLAMA_TIMEOUT_MS` is a compile-time constant (`120_000` ms) in `callOllama()`. There is no `timeout` field in `GraderConfig` and no way to configure this from `task.toml`. Known-documented issue: on Snapdragon X Elite ARM64 CPU, `qwen3:4b` (a thinking model) takes ~400–500 s per inference, meaning the 120 s timeout fires every time. The older timeout of 300 s was also insufficient. See `.planning/debug/ollama-grader-score-zero-arm64.md`.
- Files: `src/graders/index.ts` (line ~293: `const OLLAMA_TIMEOUT_MS = 120_000`)
- Impact: LLM grader silently returns `score: 0` on slow hardware, with no user-visible reason in the trial summary. The `details` field contains the explanation but `evalRunner.ts` only prints `details` for sub-0.5 scores — not for error cases.
- Fix approach: Add optional `timeout_sec` field to `GraderConfig` in `src/types.ts`; fall back to a configurable default. Expose it in `task.toml` per grader stanza.

**Token estimation is a rough approximation:**
- Issue: `estimateTokens()` in `src/evalRunner.ts` (line ~64) uses a fixed 4 chars/token heuristic (`Math.ceil(text.length / 4)`). This is documented as "standard GPT heuristic" but diverges significantly for code-heavy outputs (lower token density) and non-English text (higher token density). The resulting `input_tokens` / `output_tokens` fields in `TrialResult` are labeled as "estimated" in the CLI output.
- Files: `src/evalRunner.ts` (lines 63–66, 243–246)
- Impact: Analytics and cost projections that rely on `TrialResult.input_tokens` / `output_tokens` are unreliable. Pass-rate metrics are unaffected.
- Fix approach: Use a proper tokenizer (e.g., `tiktoken` via npm) or make the estimate label more prominent. Low priority unless token accounting becomes a product requirement.

**`sessionLog` typed as `any[]` in grader interface:**
- Issue: `Grader.grade()` in `src/graders/index.ts` (line 12) accepts `sessionLog: any[]`. The correct type is `LogEntry[]` from `src/types.ts`. This defeats TypeScript's structural checks for any code that reads `sessionLog` entries inside graders.
- Files: `src/graders/index.ts` (lines 6–14), `src/types.ts`
- Impact: No runtime bug, but type errors in graders that access session log fields are silently missed. Requires callers to cast or use optional chaining defensively.
- Fix approach: Change parameter type to `LogEntry[]` in the `Grader` interface and all implementations.

**`toml` imported via `require()` inside a function:**
- Issue: In `src/cli.ts` (line ~100), `toml` is loaded with `const toml = require('toml')` inside the `main()` function's suite-loading branch instead of at the module top level with a static `import`. The rest of the file uses ES-style imports (including `toml` in `evalRunner.ts`).
- Files: `src/cli.ts` (line ~100)
- Impact: Inconsistent module loading style; the dynamic `require` bypasses TypeScript's type import for this code path. Not a functional bug.
- Fix approach: Move to a top-level `import * as toml from 'toml'` consistent with the rest of the codebase.

**`dist/` directory committed to version control:**
- Issue: The compiled JavaScript output in `dist/` is tracked by git and present in the repository. There is no `.gitignore` entry for `dist/`. This means every `npm run build` produces a diff that must be staged and committed, or diverges silently.
- Files: `dist/` (all files), `.gitignore`
- Impact: Repository size grows with every build. CI artifacts differ from source-of-truth TypeScript. Merge conflicts on generated files are painful.
- Fix approach: Add `dist/` to `.gitignore`. Update CI to build before running tests (already done: `build` job exists in `.github/workflows/ci.yml`).

**`pass@k` and `pass^k` computed at `k = numTrials` always:**
- Issue: In `src/evalRunner.ts` (lines 121–124), `calculatePassAtK` and `calculatePassPowK` are called with `k = numTrials`. This means both metrics are computed for the specific number of trials run, not for an independently chosen `k`. Running 3 trials gives `pass@3`, not `pass@1`, `pass@3`, and `pass@5`. The metrics are valid but not the standard "k-shot" sweep seen in ML benchmarks.
- Files: `src/evalRunner.ts` (lines 121–124)
- Impact: Results cannot be directly compared to published `pass@1`, `pass@5`, `pass@10` benchmarks without re-running. Analytics script has no way to compute other `k` values from existing reports.
- Fix approach: Compute the full `pass@k` series (k=1..n) and include all values in `EvalReport`, or accept the current behavior and document the limitation clearly.

**`success` threshold hardcoded at `>= 0.5`:**
- Issue: In `src/evalRunner.ts` (line 118), `const successes = trials.filter(t => t.reward >= 0.5).length` uses a hardcoded 0.5 pass threshold. This threshold also appears in `src/reporters/cli.ts` (reward coloring), `src/reporters/browser.ts` (implicit), and `src/cli.ts` (validation check at line 170).
- Files: `src/evalRunner.ts` (line 118), `src/cli.ts` (line 170), `src/reporters/cli.ts` (line 100)
- Impact: No way to configure per-task pass thresholds (e.g., a task requiring `>= 0.8` to pass). Duplication across files creates drift risk when the threshold needs changing.
- Fix approach: Add optional `pass_threshold` to `TaskConfig` in `src/types.ts`. Default to 0.5. Pass through `EvalRunner`.

**Docker image cache key mismatch between workflow and application code:**
- Issue: `skill-eval.yml` (lines 50–51) computes the Docker cache key using `find tasks/superlint_demo -type f | sort | xargs sha256sum | sha256sum | cut -c1-16` — a workflow-level hash. `DockerProvider.prepare()` in `src/providers/docker.ts` computes its own content hash via `computeContextHash()` using SHA-256 over file paths and contents. The two hashes use different algorithms, include different path namespaces, and produce different values. A cache hit in the workflow does not guarantee the application will reuse its own cached image name.
- Files: `.github/workflows/skill-eval.yml` (lines 50–51), `src/providers/docker.ts` (lines 33–68)
- Impact: The workflow's `actions/cache` layer may load a stale image that `DockerProvider` then rebuilds from scratch because the image name computed by the app doesn't match the loaded image. Doubles Docker build time on CI instead of eliminating it.
- Fix approach: Expose `computeContextHash()` as a CLI utility (or use it directly in the workflow via `node -e`) so both the workflow cache key and the application image name derive from the same hash.

---

## Known Bugs

**LLM grader silently returns `score: 0` on timeout with no user-visible reason:**
- Symptoms: `llm_rubric` grader shows `0.00` in trial summary; no error is displayed in the trial table; deterministic grader may pass.
- Files: `src/graders/index.ts` (lines 287–335, `callOllama`), `src/evalRunner.ts` (lines 251–255, grader detail printing)
- Trigger: Ollama inference takes longer than `OLLAMA_TIMEOUT_MS` (currently `120_000` ms). Reproducible with any "thinking" model (e.g., `qwen3:4b`) on CPU-only hardware.
- Workaround: Run with cloud fallback keys (`GEMINI_API_KEY` or `ANTHROPIC_API_KEY`), or use a non-thinking model (`qwen2.5:3b`, `phi3.5:3.8b-mini-instruct-q4_K_M`) that completes within the timeout.

**`DockerProvider.runCommand()` merges stdout and stderr into a single stream:**
- Symptoms: `CommandResult.stderr` is always an empty string `''` for Docker-executed commands; all output (including error output) appears in `CommandResult.stdout`.
- Files: `src/providers/docker.ts` (lines 239–267)
- Trigger: Docker exec is started with `Tty: true`. TTY mode merges stdout and stderr at the PTY level. The `LocalProvider` correctly separates them via separate `child.stdout` and `child.stderr` data handlers.
- Workaround: None — Docker provider users cannot distinguish between stdout and stderr. Graders that use `result.stderr` to detect errors will not work as expected with `DockerProvider`.

**Parallel trial execution has a shared mutable queue race condition:**
- Symptoms: In theory, two workers in `runTrialsParallel()` could read the same index from the queue if `queue.shift()` is not atomic. In practice, JavaScript's single-threaded event loop makes this safe for in-process concurrency — but only because all workers are async, not true threads.
- Files: `src/evalRunner.ts` (lines 137–158, `runTrialsParallel`)
- Trigger: Not a practical bug with async JS. Would become a real bug if the code were ported to worker threads or another runtime.
- Workaround: N/A for current runtime. Document the assumption.

---

## Security Considerations

**Secret injection via `env` Record leaks through `LocalProvider.runCommand` process environment:**
- Risk: `LocalProvider.runCommand()` in `src/providers/local.ts` (lines 104–115) merges `process.env` with the caller-supplied `env` object and passes the result to the child shell as `childEnv`. Any secret in `env` (e.g., `ANTHROPIC_API_KEY`) is exposed to the agent command and to all child processes it spawns, including potentially untrusted task scripts.
- Files: `src/providers/local.ts` (lines 99–145)
- Current mitigation: `EvalRunner.sanitize()` in `src/evalRunner.ts` (lines 305–336) redacts `env` values from saved reports. However, the secrets are still present in the live process environment during execution.
- Recommendations: Pass only the specific environment variables required by each command. Do not pass all of `process.env` to untrusted task scripts. Consider a denylist of high-value variables (e.g., `ANTHROPIC_API_KEY`, `GEMINI_API_KEY`) that are explicitly blocked from agent subprocess scope.

**`/api/report` endpoint in browser viewer performs no path traversal protection:**
- Risk: `src/reporters/browser.ts` (lines 25–34) reads a file from `resultsDir` based on a user-supplied `file` query parameter. It uses `path.join(resolved, file)` with no sanitization. An attacker with local network access to port 3847 could supply `file=../../src/cli.ts` to read arbitrary files reachable from the server process.
- Files: `src/reporters/browser.ts` (lines 25–34)
- Current mitigation: Server binds to `localhost` only (implicit from `server.listen(PORT)`). Exposure is limited to local network or localhost.
- Recommendations: Validate that the resolved file path starts with `resolved` (the results directory) before serving. Use `path.resolve()` and check `filePath.startsWith(resolved)`.

**`ClaudeAgent` and `GeminiAgent` pipe instruction via base64 through a temp file at `/tmp/.prompt.md`:**
- Risk: Both agents in `src/agents/claude.ts` (line 11) and `src/agents/gemini.ts` (line 11) write the decoded instruction to `/tmp/.prompt.md`. This is a fixed, predictable path. In a shared multi-user environment, another process could read or overwrite this file between the write and the CLI invocation.
- Files: `src/agents/claude.ts` (lines 10–12), `src/agents/gemini.ts` (lines 10–12)
- Current mitigation: Inside Docker containers, `/tmp` is container-private. In `LocalProvider`, `/tmp` is the host system's shared temp directory.
- Recommendations: Use a unique temp file per trial (e.g., `/tmp/.prompt-${trialId}-${Date.now()}.md`) to avoid cross-trial or cross-process collisions.

---

## Performance Bottlenecks

**Ollama grader performs 2 HTTP round-trips (health + tags) before every grading call:**
- Problem: `checkOllamaAvailability()` in `src/graders/index.ts` (lines 248–285) fetches `${ollamaHost}/` and `${ollamaHost}/api/tags` on every `grade()` call. For a 5-trial evaluation with one LLM grader, this adds 10 unnecessary health checks after the first successful check.
- Files: `src/graders/index.ts` (lines 248–285)
- Cause: No caching of availability status across `grade()` calls. The `LLMGrader` instance is created fresh per grader type lookup (`getGrader()` in `evalRunner.ts` line 217).
- Improvement path: Cache the availability check result on the `LLMGrader` instance (similar to the `warmedUp` flag pattern already used). Re-check only on connection failure.

**`AnalyticsEngine.loadReports()` reads all JSON files into memory simultaneously:**
- Problem: `src/analytics/engine.ts` (lines 26–38) reads every `.json` file in `results/` into an in-memory array before aggregating. The `results/` directory already has 13 report files committed to the repository.
- Files: `src/analytics/engine.ts` (lines 26–38)
- Cause: Synchronous sequential reads with no streaming or pagination.
- Improvement path: Stream-process reports in batches. Low priority until report count exceeds ~100 files.

**`createTarFromDir()` buffers entire tar archive in memory before sending to Docker:**
- Problem: `DockerProvider.createTarFromDir()` in `src/providers/docker.ts` (lines 219–237) collects all chunks into a `Buffer[]` array and concatenates them before returning. For large skill directories, this loads the entire archive into Node.js heap.
- Files: `src/providers/docker.ts` (lines 219–237)
- Cause: `dockerode`'s `putArchive()` accepts a `Buffer` or `Stream`. Using a stream would allow backpressure.
- Improvement path: Return the `tar-stream` pack stream directly instead of buffering to a `Buffer`. Low priority until skill directories grow large.

---

## Fragile Areas

**`LLMGrader` warmup and warning flags are instance-level state:**
- Files: `src/graders/index.ts` (lines 57–59: `warnedAboutConfig`, `warmedUp`)
- Why fragile: Both flags are per-`LLMGrader` instance. `getGrader()` creates a new instance on every call (line 436). This means `warnedAboutConfig` and `warmedUp` reset to `false` for every trial's grading call, so the warmup request is sent once per trial, not once per evaluation run.
- Safe modification: If this is intentional (warmup per trial), document it. If the intent was "once per evaluation," move the `LLMGrader` instance outside `getGrader()` and reuse it across trials — or pass a shared instance through `EvalRunner`.
- Test coverage: `tests/ollama-grader.test.ts` tests warmup idempotency on a single instance but does not test the `getGrader()` factory path.

**`loadTaskConfig()` silently coerces legacy `[verifier]` format to graders:**
- Files: `src/evalRunner.ts` (lines 10–25)
- Why fragile: The normalization `if (!raw.graders && raw.verifier)` injects a hardcoded `command: 'bash tests/test.sh'` and `weight: 1.0`. If a legacy task's `test.sh` is not at that exact path, or if the weight should differ, the coercion silently produces wrong grader config with no warning. `raw` is untyped (`any`) from `toml.parse()`, so the fallback is not type-checked.
- Safe modification: Add a `console.warn()` when the legacy format is detected. Validate the normalized result against the `TaskConfig` interface before returning.
- Test coverage: No test covers the `[verifier]` legacy coercion path.

**`DockerProvider.setup()` falls back to calling `prepare()` inline:**
- Files: `src/providers/docker.ts` (lines 168–172)
- Why fragile: If `prepare()` was never called (e.g., `EvalRunner` is used directly without the `prepare` step), `setup()` silently calls `prepare()` itself. This means the image is built during the first trial instead of before trials begin. If `prepare()` throws mid-trial, the trial fails and `cleanup()` is called on a workspace that was never fully set up.
- Safe modification: Throw a clear error if `this.preparedImage` is undefined and `setup()` is called — or document that this lazy-init path is intentional and covered.
- Test coverage: `tests/bootstrap.test.ts` tests Docker with the full `EvalRunner` path but does not test `setup()` called before `prepare()`.

**Browser viewer server never closes:**
- Files: `src/reporters/browser.ts` (lines 42–46)
- Why fragile: `server.listen()` is called with no mechanism to close the server. In CI (`npm run preview` in `skill-eval.yml`), the process hangs after printing the URL because the HTTP server keeps the event loop alive. The CI job only completes because the `if: always()` step has the 30-minute job timeout as a hard ceiling.
- Safe modification: Add a `--once` flag or a `SIGINT` handler that closes the server. For CI use, add a `--ci` flag that prints available report paths to stdout and exits immediately without starting an HTTP server.
- Test coverage: No test exists for `browser.ts`.

---

## Scaling Limits

**Single task definition (`superlint_demo`):**
- Current capacity: 1 task, 1 suite (`suites/workflow.toml`).
- Limit: The CLI, validation scripts, and suite config all reference `superlint_demo` by name. There is no templating or generator for new tasks.
- Scaling path: Add a task creation guide and template directory. The framework architecture supports N tasks — the gaps are documentation and tooling.

**Results directory grows unbounded:**
- Current capacity: 13 result JSON files already committed to the repo.
- Limit: No rotation, pruning, or archiving. `loadReports()` reads all files on every `npm run analyze`.
- Scaling path: Add a `--limit=N` flag to `analyze.ts`. Consider moving results to `.gitignore` or a separate `results/` subdirectory that is not committed.

---

## Dependencies at Risk

**`toml` package (v3.0.0) is unmaintained:**
- Risk: The `toml` package has not had a release since 2015. It is a pure parser with no active maintenance. Edge cases in TOML spec (multi-line strings, datetime, nested arrays) may not parse correctly.
- Impact: `loadTaskConfig()` and `src/cli.ts` both depend on it for all task and suite config parsing.
- Migration plan: Replace with `smol-toml` (actively maintained, spec-compliant) or `@ltd/j-toml`. Both are drop-in compatible for the current TOML syntax used in `task.toml` and suite files.

**`dockerode` bound to Docker API version assumptions:**
- Risk: `dockerode@4.0.9` communicates with the Docker daemon via the Docker Engine API. Significant Docker Desktop version upgrades (e.g., moving to Docker Engine v28+) may change API behavior for exec streams, particularly the `Tty: true` stream demuxing behavior relied upon in `runCommand()`.
- Impact: `DockerProvider.runCommand()` would silently return garbled output.
- Migration plan: Monitor `dockerode` releases. Add an integration test that verifies the stdout/stderr split behavior after Docker Desktop upgrades.

---

## Missing Critical Features

**No per-task configurable LLM grader timeout:**
- Problem: `OLLAMA_TIMEOUT_MS` is hardcoded at `120_000` ms. Tasks that require complex reasoning (larger transcripts, multi-step agent outputs) may need longer timeouts; simple tasks could use shorter ones to fail fast.
- Blocks: Using thinking models (e.g., `qwen3:4b`) reliably on CPU hardware; adding tasks with longer expected grading times.

**No model setup / preflight check script:**
- Problem: There is no `npm run setup` or equivalent that verifies Ollama is running, the required model (`qwen2.5:3b` by default) is pulled, and Docker is available. First-time users encounter cryptic failures.
- Blocks: Smooth developer onboarding; CI setup documentation.

**No path traversal protection in browser viewer:**
- Problem: `src/reporters/browser.ts` serves arbitrary files from `resultsDir` without path sanitization (see Security Considerations above).
- Blocks: Safe exposure of the viewer on any network beyond strict localhost.

---

## Test Coverage Gaps

**Legacy `[verifier]` → `[[graders]]` coercion path:**
- What's not tested: The backward-compatibility normalization in `loadTaskConfig()` at `src/evalRunner.ts` (lines 16–23) that converts old `[verifier]` format to the new `[[graders]]` format.
- Files: `src/evalRunner.ts` (lines 10–25)
- Risk: A malformed coercion would silently run the wrong grader command (hardcoded `bash tests/test.sh`) or wrong weight.
- Priority: Low — the legacy format is not used by any current task.

**`browser.ts` reporter is completely untested:**
- What's not tested: HTTP server creation, `/api/reports` endpoint, `/api/report` endpoint, path traversal vulnerability, server lifecycle.
- Files: `src/reporters/browser.ts`
- Risk: Path traversal exploit (see Security Considerations). Silent regressions in report serving.
- Priority: Medium — the path traversal gap alone warrants a basic test.

**`cli.ts` argument parsing and suite loading:**
- What's not tested: `--suite` flag, `--validate` flag, `--no-skills` flag, ambiguous task prefix matching, missing task error handling.
- Files: `src/cli.ts`
- Risk: Flag parsing regressions go undetected. Suite loading errors produce unhelpful messages.
- Priority: Low — these are thin CLI wrappers over tested core logic.

**`DockerProvider.prepare()` cache-hit path:**
- What's not tested: The code path in `prepare()` where the image already exists in Docker cache (lines 94–99 in `docker.ts`). `docker-cache.test.ts` tests the hash function but not the Docker image existence check.
- Files: `src/providers/docker.ts` (lines 84–162)
- Risk: Cache-hit path regression (image reuse silently broken) would cause every evaluation to rebuild the Docker image.
- Priority: Medium — regression would be expensive in CI time.

**`EvalRunner` error handling and trial failure paths:**
- What's not tested: The `catch` block in `runSingleTrial()` (lines 267–299 in `evalRunner.ts`) that handles agent timeouts and unexpected exceptions. The diagnostics capture path (`provider.diagnose()`) is also untested.
- Files: `src/evalRunner.ts` (lines 267–302)
- Risk: Error handling regressions produce misleading trial results or crashes that skip cleanup.
- Priority: Medium — error paths are the hardest to debug in production.

---

*Concerns audit: 2026-03-10*
