---
phase: 6
slug: ci-integration
status: draft
nyquist_compliant: false
wave_0_complete: false
created: 2026-03-15
---

# Phase 6 — Validation Strategy

> Per-phase validation contract for feedback sampling during execution.

---

## Test Infrastructure

| Property | Value |
|----------|-------|
| **Framework** | GitHub Actions workflow execution (CI-focused phase — no unit test runner) |
| **Config file** | `.github/workflows/skill-eval.yml` |
| **Quick run command** | `gh workflow run skill-eval.yml` |
| **Full suite command** | Push to PR — all workflow jobs run |
| **Estimated runtime** | ~20-30 minutes (4 matrix combos + validate-graders) |

---

## Sampling Rate

- **After every task commit:** Push to PR branch, verify affected workflow jobs
- **After every plan wave:** Full workflow run on PR (all matrix combos)
- **Before `/gsd:verify-work`:** All 4 agent-eval matrix jobs green + validate-graders green
- **Max feedback latency:** ~25 minutes (CI round-trip)

---

## Per-Task Verification Map

| Task ID | Plan | Wave | Requirement | Test Type | Automated Command | File Exists | Status |
|---------|------|------|-------------|-----------|-------------------|-------------|--------|
| 06-01-01 | 01 | 1 | CI-01 | CI workflow | Push to PR, check setup-ollama step logs | N/A (workflow) | pending |
| 06-01-02 | 01 | 1 | CI-04 | CI env check | Verify `OLLAMA_MAX_LOADED_MODELS=1` in workflow logs | N/A (workflow) | pending |
| 06-02-01 | 02 | 1 | CI-02 | CI workflow | Push to PR, check setup-opencode step logs | N/A (workflow) | pending |
| 06-03-01 | 03 | 1 | CI-03 | CI workflow | Push to PR, check agent-eval matrix jobs | N/A (workflow) | pending |
| 06-03-02 | 03 | 1 | CI-03 | CI smoke | `getconf PAGE_SIZE` diagnostic in workflow logs | N/A (workflow) | pending |

*Status: pending / green / red / flaky*

---

## Wave 0 Requirements

- [ ] `modelfiles/qwen3-4b-skill-eval-opencode-agent.ci.Modelfile` — CI Modelfile for opencode agent model (3 threads)
- [ ] `.github/actions/setup-opencode/action.yml` — new composite action scaffold
- [ ] Docker detection fix in `src/agents/opencode/index.ts` — cgroup v2 compatibility (`/.dockerenv` check)

*These are prerequisites that must exist before CI workflow changes can work.*

---

## Manual-Only Verifications

| Behavior | Requirement | Why Manual | Test Instructions |
|----------|-------------|------------|-------------------|
| ARM64 runner compatibility | CI-03 | GitHub-hosted runner hardware cannot be locally simulated | Push PR, verify no SIGABRT (exit 134) in opencode jobs |
| OOM prevention | CI-04 | 16GB RAM constraint only exists on CI runners | Monitor runner memory usage in workflow logs during agent-eval |

---

## Validation Sign-Off

- [ ] All tasks have CI workflow verification or Wave 0 dependencies
- [ ] Sampling continuity: every commit pushed to PR for CI feedback
- [ ] Wave 0 covers all MISSING references (Modelfile, setup-opencode, Docker detection)
- [ ] No watch-mode flags
- [ ] Feedback latency < 30 minutes (CI round-trip)
- [ ] `nyquist_compliant: true` set in frontmatter

**Approval:** pending
