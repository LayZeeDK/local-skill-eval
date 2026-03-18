---
phase: 05-opencodeagent
plan: 02
subsystem: cli
tags: [opencode, cli-wiring, smoke-test, agent-selection, model-unload]

# Dependency graph
requires:
  - phase: 05-opencodeagent
    plan: 01
    provides: "OpenCodeAgent class extending BaseAgent with run() method"
provides:
  - "--agent=opencode CLI flag with help text"
  - "Pre-eval smoke test gate verifying Ollama connectivity for opencode"
  - "Pre-eval model unloading for opencode agent"
  - "Agent selection switch case instantiating OpenCodeAgent"
  - "7 CLI wiring tests for opencode integration"
affects: [05-03 end-to-end validation, 06 CI setup]

# Tech tracking
tech-stack:
  added: []
  patterns: [opencode-smoke-test-ollama-list, shared-model-unload-pattern]

key-files:
  created:
    - tests/cli-opencode-flag.test.ts
  modified:
    - src/cli.ts
    - package.json

key-decisions:
  - "Opencode smoke test uses Ollama client.list() instead of opencode --version since runCommand is unavailable at CLI setup time"
  - "Model unload pattern duplicated from ollama block rather than extracting shared function to minimize risk"

patterns-established:
  - "CLI agent wiring: import, help text, pre-eval block, switch case -- same 4-step pattern for all agents"
  - "Smoke test gate: lightweight connectivity check before expensive eval runs"

requirements-completed: [PIPE-02, AGENT-02]

# Metrics
duration: 2min
completed: 2026-03-11
---

# Phase 05 Plan 02: CLI Wiring for OpenCodeAgent Summary

**--agent=opencode CLI flag with Ollama connectivity smoke test, model unloading, and 7 wiring tests**

## Performance

- **Duration:** 2 min
- **Started:** 2026-03-11T17:41:46Z
- **Completed:** 2026-03-11T17:44:01Z
- **Tasks:** 2
- **Files modified:** 3

## Accomplishments
- OpenCodeAgent wired into CLI with --agent=opencode flag, help text, pre-eval setup, and switch case
- Pre-eval smoke test verifies Ollama connectivity before expensive eval runs
- Pre-eval model unloading frees RAM/CPU by unloading non-agent models
- 7 CLI wiring tests all passing, 13 agent tests still green, TypeScript compiles clean

## Task Commits

Each task was committed atomically:

1. **Task 1: Wire OpenCodeAgent into CLI with smoke test gate** - `580917f` (feat)
2. **Task 2: Create CLI wiring tests and npm script** - `abe5df8` (test)

## Files Created/Modified
- `src/cli.ts` - Added OpenCodeAgent import, help text update, pre-eval smoke test + model unload, switch case
- `tests/cli-opencode-flag.test.ts` - 7 tests verifying CLI wiring for opencode agent
- `package.json` - Added test:cli-opencode-flag npm script

## Decisions Made
- Opencode smoke test uses `client.list()` (Ollama connectivity check) rather than `opencode --version` because `runCommand` is not available at CLI setup time -- opencode binary availability is implicitly tested when the first trial runs
- Model unload pattern is duplicated from the ollama block rather than extracted to a shared function, following the plan's "extend, don't modify" principle to minimize risk to existing code

## Deviations from Plan

None - plan executed exactly as written.

## Issues Encountered
None

## User Setup Required
None - no external service configuration required.

## Next Phase Readiness
- CLI fully wired for --agent=opencode, ready for end-to-end validation in Plan 03
- Smoke test gate will prevent wasted eval time when Ollama is misconfigured
- All existing agent tests (ollama, gemini, claude) unaffected

## Self-Check: PASSED

- [x] src/cli.ts - FOUND
- [x] tests/cli-opencode-flag.test.ts - FOUND
- [x] Commit 580917f - FOUND
- [x] Commit abe5df8 - FOUND

---
*Phase: 05-opencodeagent*
*Completed: 2026-03-11*
