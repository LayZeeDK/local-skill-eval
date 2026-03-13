---
phase: 05-opencodeagent
plan: 01
subsystem: agents
tags: [opencode, ollama, cli-agent, timeout, config-injection]

# Dependency graph
requires:
  - phase: 04.1-tune-ollama-agent
    provides: "qwen2.5-3b-skill-eval-agent Modelfile and proven model config"
provides:
  - "OpenCodeAgent class extending BaseAgent with run() method"
  - "Static opencode.skill-eval-agent.json config template"
  - "Config injection, timeout wrapper, and model unload patterns"
  - "13 unit tests covering constructability, config, and source patterns"
affects: [05-02 CLI wiring, 05-03 end-to-end validation, 06 CI setup]

# Tech tracking
tech-stack:
  added: [tree-kill]
  patterns: [config-injection-before-cli-launch, bash-timeout-wrapper, base64-config-injection]

key-files:
  created:
    - src/agents/opencode/index.ts
    - src/agents/opencode/opencode.skill-eval-agent.json
    - tests/opencode-agent.test.ts
  modified:
    - package.json
    - package-lock.json

key-decisions:
  - "Static config copied as-is to workspace; Docker baseURL adjustment deferred to Plan 03"
  - "Bash timeout command as primary hang protection; fallback to no-timeout when timeout binary unavailable"
  - "@types/tree-kill not available on npm; tree-kill ships its own .d.ts types"

patterns-established:
  - "Config injection: read static JSON, base64-encode, write to workspace CWD via runCommand"
  - "Timeout wrapper: bash timeout --signal=TERM --kill-after=10 for opencode hang protection"
  - "Fallback path: exit code 127 detection for missing timeout binary"

requirements-completed: [AGENT-02, PIPE-04]

# Metrics
duration: 2min
completed: 2026-03-11
---

# Phase 05 Plan 01: OpenCodeAgent Core Summary

**OpenCodeAgent class wrapping opencode CLI with config injection, bash timeout protection, and Ollama model unload in finally block**

## Performance

- **Duration:** 2 min
- **Started:** 2026-03-11T17:36:20Z
- **Completed:** 2026-03-11T17:38:47Z
- **Tasks:** 2
- **Files modified:** 5

## Accomplishments
- OpenCodeAgent class extending BaseAgent with config injection, timeout wrapper, and model unload
- Static opencode.json config template with Ollama provider, correct model, /v1 baseURL, and all explicit permissions
- 13 unit tests passing without live Ollama or opencode binary
- tree-kill dependency installed for cross-platform process tree termination

## Task Commits

Each task was committed atomically:

1. **Task 1: Create OpenCodeAgent class and config template** - `401873d` (feat)
2. **Task 2: Create unit tests and npm scripts** - `04f1250` (test)

## Files Created/Modified
- `src/agents/opencode/index.ts` - OpenCodeAgent class with config injection, timeout, model unload
- `src/agents/opencode/opencode.skill-eval-agent.json` - Static opencode config for Ollama provider
- `tests/opencode-agent.test.ts` - 13 unit tests for constructability, config, source patterns
- `package.json` - Added tree-kill dependency and test:opencode-agent script
- `package-lock.json` - Lock file updated for tree-kill

## Decisions Made
- Static config copied as-is to workspace; Docker baseURL adjustment deferred to Plan 03 end-to-end validation
- Bash `timeout` command used as primary hang protection; exit code 127 triggers fallback to running without timeout wrapper
- @types/tree-kill does not exist on npm; tree-kill ships its own TypeScript definitions -- no separate types package needed

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 3 - Blocking] @types/tree-kill package not found on npm**
- **Found during:** Task 1 (dependency installation)
- **Issue:** Plan specified `npm install -D @types/tree-kill` but the package does not exist on the npm registry (404)
- **Fix:** Verified tree-kill ships its own `index.d.ts` -- no separate @types package needed, skipped installation
- **Files modified:** None (no fix required, types already bundled)
- **Verification:** TypeScript compilation succeeds with tree-kill types from the package itself
- **Committed in:** 401873d (Task 1 commit)

---

**Total deviations:** 1 auto-fixed (1 blocking)
**Impact on plan:** Minor -- the package bundles its own types, so the missing @types package is a non-issue.

## Issues Encountered
None

## User Setup Required
None - no external service configuration required.

## Next Phase Readiness
- OpenCodeAgent ready for CLI wiring in Plan 02 (--agent=opencode flag, help text, agent selection switch)
- Config template ready for Docker variant adjustment in Plan 03 if needed
- tree-kill available for future process tree killing if bash timeout proves insufficient

## Self-Check: PASSED

- [x] src/agents/opencode/index.ts - FOUND
- [x] src/agents/opencode/opencode.skill-eval-agent.json - FOUND
- [x] tests/opencode-agent.test.ts - FOUND
- [x] Commit 401873d - FOUND
- [x] Commit 04f1250 - FOUND

---
*Phase: 05-opencodeagent*
*Completed: 2026-03-11*
