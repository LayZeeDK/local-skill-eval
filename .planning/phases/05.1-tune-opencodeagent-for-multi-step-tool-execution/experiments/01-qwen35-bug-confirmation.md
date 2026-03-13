# Experiment 01: Qwen 3.5 Bug Confirmation

## Configuration

- **Model:** qwen3.5-4b-opencode-agent (FROM qwen3.5:4b)
- **Modelfile params:** num_ctx 8192, num_predict 4096, temperature 0, num_batch 1024, num_thread 8
- **OpenCode config:** 8 denied tools (glob, grep, list, task, todowrite, skill, webfetch, websearch, codesearch, external_directory), 4 allowed (bash, read, edit, write)
- **Prompt prefix:** Research-recommended multi-step reinforcement + /no_think
- **Task:** superlint_demo (3-step tool workflow: check, fix, verify)
- **Platform:** Windows 11 ARM64, opencode x64 binary via QEMU emulation

## Results

### Warmup Trial (discarded)

| Metric | Value |
|--------|-------|
| Duration | 176.6s |
| Reward | 0.00 |
| Commands | 8 (5 setup + 3 opencode attempts) |
| Tokens (in/out) | ~268/130 |
| SIGSEGV | 3/3 attempts (100%) |
| Failure mode | SIGSEGV on all 3 retry attempts |

### Screening Trial

| Metric | Value |
|--------|-------|
| Duration | 120.0s |
| Reward | 0.00 |
| Commands | 8 (5 setup + 3 opencode attempts) |
| Tokens (in/out) | ~268/118 |
| SIGSEGV | 3/3 attempts (100%) |
| Failure mode | SIGSEGV on all 3 retry attempts |

## Tool Calls Observed

None. The opencode x64 binary crashed (SIGSEGV, exit code 139) on every attempt before the model could generate any output. The model never reached the tool-calling stage.

## Analysis

**Bug confirmation: INCONCLUSIVE.** The Qwen 3.5 tool-calling bug (Ollama issues #14493, #14745) could not be confirmed or disproven because the opencode x64 binary segfaults under QEMU emulation before the model generates any response.

Key observations:
- 6/6 opencode invocations across both trials hit SIGSEGV (100% crash rate)
- This is significantly higher than the documented ~60% SIGSEGV rate from Phase 5
- No model output was captured -- the binary crashes during initialization or early inference
- The SIGSEGV is a QEMU x64-on-ARM64 emulation issue, not a model issue

## Conclusion

The Qwen 3.5 Ollama tool-calling bug remains unconfirmed on this platform. The SIGSEGV crash rate has increased from ~60% (Phase 5) to 100% in this session, making any model-level testing impossible through the opencode binary. Alternative approaches would be needed to confirm the bug (e.g., direct Ollama API testing without opencode, or testing on x64 hardware).

## Result Files

- Warmup: `results/superlint_demo_2026-03-11T23-03-27-323Z.json`
- Screening: `results/superlint_demo_2026-03-11T23-06-08-953Z.json`
