---
phase: 04-ollamatoolagent-ollama-model-setup
plan: 02
subsystem: agents
tags: [ollama, tool-calling, agent-loop, smoke-test, cli, keep-alive, model-unload]

# Dependency graph
requires:
  - phase: 04-01
    provides: "Tool definitions, permission system, types, Modelfile"
provides:
  - "OllamaToolAgent class with iterative tool-calling loop"
  - "Smoke test gate verifying structured tool_calls before eval"
  - "--agent=ollama CLI flag with agent selection switch"
  - "Model unloading via keep_alive: 0 after agent run"
affects: [04-03-PLAN]

# Tech tracking
tech-stack:
  added: []
  patterns: [ollama-chat-tool-loop, smoke-test-gate, model-unload-finally]

key-files:
  created:
    - src/agents/ollama/index.ts
    - src/agents/ollama/smoke-test.ts
    - tests/ollama-agent.test.ts
    - tests/cli-ollama-flag.test.ts
    - tests/smoke-gate.test.ts
    - tests/model-unload.test.ts
  modified:
    - src/cli.ts
    - package.json

key-decisions:
  - "Used finally block for model unload to ensure cleanup even on agent errors"
  - "Smoke test uses minimal num_ctx 4096 and num_predict 256 for fast validation"

patterns-established:
  - "Agent tool-calling loop: chat with tools, check tool_calls, execute, push tool role, repeat"
  - "Model lifecycle: agent unloads model via keep_alive: 0 in finally block before grading starts"
  - "Smoke test gate: verify structured tool_calls before running full eval"

requirements-completed: [AGENT-01, PIPE-01, PIPE-03, OLCFG-03]

# Metrics
duration: 3min
completed: 2026-03-10
---

# Phase 4 Plan 02: OllamaToolAgent, CLI Integration, Smoke Test, and Model Unload Summary

**OllamaToolAgent with iterative tool-calling loop, --agent=ollama CLI flag, smoke test gate, and keep_alive: 0 model unloading**

## Performance

- **Duration:** 3 min
- **Started:** 2026-03-10T14:21:53Z
- **Completed:** 2026-03-10T14:24:36Z
- **Tasks:** 2
- **Files modified:** 8

## Accomplishments

- Built OllamaToolAgent extending BaseAgent with iterative ollama.chat tool-calling loop
- Wired --agent=ollama into CLI with agent selection switch and smoke test gate
- Model unloads via keep_alive: 0 in finally block, preventing OOM before grading
- 19 new test assertions across 4 test scripts, all passing

## Task Commits

Each task was committed atomically:

1. **Task 1: Implement OllamaToolAgent class and smoke test** - `26b9c3f` (feat)
2. **Task 2: Wire --agent=ollama into CLI, add tests** - `70cd2b8` (feat)

## Files Created/Modified

- `src/agents/ollama/index.ts` - OllamaToolAgent class with tool-calling loop and model unload
- `src/agents/ollama/smoke-test.ts` - smokeTestToolCalling function verifying structured tool_calls
- `src/cli.ts` - Updated with --agent=ollama flag, smoke test gate, OllamaToolAgent import
- `tests/ollama-agent.test.ts` - 5 assertions: constructor, BaseAgent inheritance, run method, smokeTest export
- `tests/cli-ollama-flag.test.ts` - 6 assertions: help text, imports, agent selection, smoke gate
- `tests/smoke-gate.test.ts` - 4 assertions: export type, async behavior, connection refused handling
- `tests/model-unload.test.ts` - 4 assertions: keep_alive pattern, value 0, finally block, inner try/catch
- `package.json` - Added 4 test scripts

## Decisions Made

- Used finally block for model unload to ensure cleanup even on agent errors
- Smoke test uses minimal num_ctx 4096 and num_predict 256 for fast validation
- think: false on all chat calls to disable Qwen3 thinking mode per CONTEXT.md guidance

## Deviations from Plan

None - plan executed exactly as written.

## Issues Encountered

None.

## User Setup Required

None - no external service configuration required.

## Next Phase Readiness

- OllamaToolAgent fully wired into CLI, ready for Plan 03 integration testing
- Smoke test gate will verify model produces structured tool_calls before live eval
- Model unload ensures RAM is freed before grading starts

## Self-Check: PASSED

All 7 created files exist on disk. Both task commits (26b9c3f, 70cd2b8) found in git log.

---
*Phase: 04-ollamatoolagent-ollama-model-setup*
*Completed: 2026-03-10*
