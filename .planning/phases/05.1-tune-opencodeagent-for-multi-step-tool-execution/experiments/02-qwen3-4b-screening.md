# Experiment 02: Qwen3:4b Screening

## Configuration

- **Model:** qwen3-4b-opencode-agent (FROM qwen3:4b)
- **Modelfile params:** num_ctx 8192, num_predict 4096, temperature 0, num_batch 1024, num_thread 8
- **OpenCode config:** 8 denied tools (glob, grep, list, task, todowrite, skill, webfetch, websearch, codesearch, external_directory), 4 allowed (bash, read, edit, write)
- **Prompt prefix:** Research-recommended multi-step reinforcement + /no_think
- **Task:** superlint_demo (3-step tool workflow: check, fix, verify)
- **Platform:** Windows 11 ARM64, opencode x64 binary via QEMU emulation

## Results

### Warmup Trial (discarded)

| Metric | Value |
|--------|-------|
| Duration | 119.8s |
| Reward | 0.00 |
| Commands | 8 (5 setup + 3 opencode attempts) |
| Tokens (in/out) | ~268/118 |
| SIGSEGV | 3/3 attempts (100%) |
| Failure mode | SIGSEGV on all 3 retry attempts |

### Screening Trial

| Metric | Value |
|--------|-------|
| Duration | 600.1s (timeout) |
| Reward | N/A (no result file -- EBUSY error on cleanup) |
| Commands | 5 setup + 1 opencode run (survived SIGSEGV) |
| SIGSEGV | 0/1 attempt (0%) -- opencode survived |
| Failure mode | Timeout at 600s -- agent could not complete 3-step workflow |

## Tool Calls Observed

**Warmup:** None -- SIGSEGV on all 3 attempts.

**Screening:** The opencode binary survived QEMU emulation on the first attempt (confirmed via `ollama ps` showing `qwen3-4b-opencode-agent` actively loaded for several minutes). The model was actively generating and presumably executing tool calls, but could not complete the 3-step superlint workflow within the 600s timeout. No intermediate output was captured (opencode run only returns on completion).

## Analysis

Mixed results:
1. **Warmup trial:** Same 100% SIGSEGV pattern as Qwen 3.5 experiments
2. **Screening trial:** opencode survived QEMU emulation and the model was actively working, but timed out at 600s

The screening trial is the first successful opencode execution in this session (1 success out of 16 total attempts across all experiments). The model loaded, generated responses, and presumably made tool calls -- but could not finish the multi-step workflow in 10 minutes.

Possible explanations for the timeout:
- Model is stuck in a loop (making tool calls but not progressing)
- Slow CPU-only inference on qwen3:4b through opencode's agent loop
- Model makes incorrect tool calls and retries repeatedly
- Context window fills up and model behavior degrades

Without intermediate output, we cannot determine which of these occurred.

## Conclusion

**Qwen3:4b shows partial progress:** the opencode binary can survive QEMU emulation (1/4 attempts = 25% success), and the model is capable of engaging with tool calls. However, it cannot complete the 3-step workflow within the 600s timeout.

This is a marginal improvement over Phase 5's results where the model couldn't complete tool workflows at all. The primary blocker remains the SIGSEGV crash rate (75% in this experiment, vs ~60% historically).

**Recommendation:** The SIGSEGV rate makes reliable testing on this platform extremely difficult. Plan 02 should:
1. Consider increasing SIGSEGV retry count (e.g., 5 retries instead of 3)
2. Investigate whether intermediate output can be captured from opencode
3. Consider testing tool calling directly via Ollama API (bypassing opencode) to isolate model vs. platform issues

## Result Files

- Warmup: `results/superlint_demo_2026-03-11T23-09-32-845Z.json`
- Screening: No result file saved (eval process crashed with EBUSY on cleanup after 600s timeout)
