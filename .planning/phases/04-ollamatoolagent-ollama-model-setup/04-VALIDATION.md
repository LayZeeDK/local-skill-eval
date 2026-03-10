---
phase: 4
slug: ollamatoolagent-ollama-model-setup
status: draft
nyquist_compliant: false
wave_0_complete: false
created: 2026-03-10
---

# Phase 4 -- Validation Strategy

> Per-phase validation contract for feedback sampling during execution.

---

## Test Infrastructure

| Property | Value |
|----------|-------|
| **Framework** | ts-node standalone scripts (project convention) |
| **Config file** | N/A (standalone scripts using assert module) |
| **Quick run command** | `npx ts-node tests/modelfile-config.test.ts` |
| **Full suite command** | `npx ts-node tests/permissions.test.ts && npx ts-node tests/path-traversal.test.ts && npx ts-node tests/ollama-agent.test.ts && npx ts-node tests/modelfile-config.test.ts && npx ts-node tests/cli-ollama-flag.test.ts && npx ts-node tests/smoke-gate.test.ts && npx ts-node tests/model-unload.test.ts` |
| **Estimated runtime** | ~15 seconds (unit tests) / ~60 seconds (integration tests requiring Ollama) |

---

## Sampling Rate

- **After every task commit:** Run `npx ts-node tests/modelfile-config.test.ts`
- **After every plan wave:** Run the full suite command above
- **Before `/gsd:verify-work`:** Full suite must be green
- **Max feedback latency:** 60 seconds

---

## Per-Task Verification Map

| Task ID | Plan | Wave | Requirement | Test Type | Automated Command | File Exists | Status |
|---------|------|------|-------------|-----------|-------------------|-------------|--------|
| 04-01-01 | 01 | 1 | OLCFG-01 | unit | `npx ts-node tests/modelfile-config.test.ts` | No -- W0 | pending |
| 04-01-02 | 01 | 1 | OLCFG-02 | unit | `npx ts-node tests/modelfile-config.test.ts` | No -- W0 | pending |
| 04-02-01 | 02 | 2 | AGENT-01 | integration | `npx ts-node tests/ollama-agent.test.ts` | No -- W0 | pending |
| 04-02-02 | 02 | 2 | AGENT-01 | unit | `npx ts-node tests/permissions.test.ts` | No -- W0 | pending |
| 04-02-03 | 02 | 2 | AGENT-01 | unit | `npx ts-node tests/path-traversal.test.ts` | No -- W0 | pending |
| 04-02-04 | 02 | 2 | PIPE-01 | unit | `npx ts-node tests/cli-ollama-flag.test.ts` | No -- W0 | pending |
| 04-02-05 | 02 | 2 | PIPE-03 | unit | `npx ts-node tests/smoke-gate.test.ts` | No -- W0 | pending |
| 04-02-06 | 02 | 2 | OLCFG-03 | integration | `npx ts-node tests/model-unload.test.ts` | No -- W0 | pending |
| 04-03-01 | 03 | 3 | AGENT-01 | e2e | `npm run eval -- superlint_demo --agent=ollama --provider=local --trials=1` | N/A | pending |

*Status: pending / green / red / flaky*

---

## Wave 0 Requirements

- [ ] `tests/modelfile-config.test.ts` -- unit test for Modelfile content validation (created by Plan 01 Task 1)
- [ ] `tests/permissions.test.ts` -- unit test for three-tier permission system (created by Plan 01 Task 2)
- [ ] `tests/path-traversal.test.ts` -- unit test for path-scoping defense (created by Plan 01 Task 2)
- [ ] `tests/ollama-agent.test.ts` -- unit test for OllamaToolAgent constructability (created by Plan 02 Task 2)
- [ ] `tests/cli-ollama-flag.test.ts` -- unit test for --agent=ollama CLI flag (created by Plan 02 Task 2)
- [ ] `tests/smoke-gate.test.ts` -- unit test for smoke test gate logic (created by Plan 02 Task 2)
- [ ] `tests/model-unload.test.ts` -- unit test for model unloading pattern (created by Plan 02 Task 2)

---

## Manual-Only Verifications

| Behavior | Requirement | Why Manual | Test Instructions |
|----------|-------------|------------|-------------------|
| superlint_demo completes with OllamaToolAgent | AGENT-01, PIPE-01 | Requires running Ollama server with qwen3:8b model pulled | 1. Start Ollama, 2. `ollama create qwen3-agent -f modelfiles/qwen3-agent.Modelfile`, 3. `npm run eval -- superlint_demo --agent=ollama --provider=local --trials=1`, 4. Verify task completes with non-zero score |
| Sequential model loading prevents OOM | OLCFG-03 | Requires monitoring system memory during eval run | 1. Run full eval, 2. Monitor `ollama ps` between agent and grader phases, 3. Verify agent model unloaded before grader loads |

---

## Validation Sign-Off

- [ ] All tasks have `<automated>` verify or Wave 0 dependencies
- [ ] Sampling continuity: no 3 consecutive tasks without automated verify
- [ ] Wave 0 covers all MISSING references
- [ ] No watch-mode flags
- [ ] Feedback latency < 60s
- [ ] `nyquist_compliant: true` set in frontmatter

**Approval:** pending
