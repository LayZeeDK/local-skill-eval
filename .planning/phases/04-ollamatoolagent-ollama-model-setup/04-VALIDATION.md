---
phase: 4
slug: ollamatoolagent-ollama-model-setup
status: draft
nyquist_compliant: false
wave_0_complete: false
created: 2026-03-10
---

# Phase 4 — Validation Strategy

> Per-phase validation contract for feedback sampling during execution.

---

## Test Infrastructure

| Property | Value |
|----------|-------|
| **Framework** | vitest (project convention from Phase 3) |
| **Config file** | `vitest.config.ts` (existing) |
| **Quick run command** | `npx vitest run tests/ollama-smoke.test.ts` |
| **Full suite command** | `npx vitest run tests/ollama-*.test.ts tests/permissions.test.ts tests/path-traversal.test.ts` |
| **Estimated runtime** | ~15 seconds (unit tests) / ~60 seconds (integration tests requiring Ollama) |

---

## Sampling Rate

- **After every task commit:** Run `npx vitest run tests/ollama-smoke.test.ts`
- **After every plan wave:** Run `npx vitest run tests/ollama-*.test.ts tests/permissions.test.ts tests/path-traversal.test.ts`
- **Before `/gsd:verify-work`:** Full suite must be green
- **Max feedback latency:** 60 seconds

---

## Per-Task Verification Map

| Task ID | Plan | Wave | Requirement | Test Type | Automated Command | File Exists | Status |
|---------|------|------|-------------|-----------|-------------------|-------------|--------|
| 04-01-01 | 01 | 1 | OLCFG-01 | unit | `npx vitest run tests/modelfile-config.test.ts` | No -- W0 | pending |
| 04-01-02 | 01 | 1 | OLCFG-02 | unit | `npx vitest run tests/modelfile-config.test.ts` | No -- W0 | pending |
| 04-02-01 | 02 | 1 | AGENT-01 | integration | `npx vitest run tests/ollama-agent.test.ts` | No -- W0 | pending |
| 04-02-02 | 02 | 1 | AGENT-01 | unit | `npx vitest run tests/permissions.test.ts` | No -- W0 | pending |
| 04-02-03 | 02 | 1 | AGENT-01 | unit | `npx vitest run tests/path-traversal.test.ts` | No -- W0 | pending |
| 04-03-01 | 03 | 2 | PIPE-01 | unit | `npx vitest run tests/cli-ollama-flag.test.ts` | No -- W0 | pending |
| 04-03-02 | 03 | 2 | PIPE-03 | unit | `npx vitest run tests/smoke-gate.test.ts` | No -- W0 | pending |
| 04-03-03 | 03 | 2 | OLCFG-03 | integration | `npx vitest run tests/model-unload.test.ts` | No -- W0 | pending |
| 04-04-01 | 04 | 3 | AGENT-01 | e2e | `npm run eval -- superlint_demo --agent=ollama --provider=local --trials=1` | N/A | pending |

*Status: pending / green / red / flaky*

---

## Wave 0 Requirements

- [ ] `tests/ollama-smoke.test.ts` -- smoke test for tool calling (requires running Ollama)
- [ ] `tests/ollama-agent.test.ts` -- integration test for OllamaToolAgent loop (requires running Ollama)
- [ ] `tests/permissions.test.ts` -- unit test for three-tier permission system (no Ollama needed)
- [ ] `tests/path-traversal.test.ts` -- unit test for path-scoping defense (no Ollama needed)
- [ ] `tests/modelfile-config.test.ts` -- unit test for Modelfile content validation
- [ ] `tests/cli-ollama-flag.test.ts` -- unit test for --agent=ollama CLI flag
- [ ] `tests/smoke-gate.test.ts` -- unit test for smoke test gate logic
- [ ] `tests/model-unload.test.ts` -- integration test for model unloading (requires running Ollama)

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
