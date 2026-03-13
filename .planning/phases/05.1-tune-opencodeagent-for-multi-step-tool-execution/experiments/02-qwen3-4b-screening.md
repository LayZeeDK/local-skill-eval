# Experiment 02: Model Screening (ARM64 Binary)

## Configuration

- **Platform:** Windows 11 ARM64, opencode native arm64 binary (0.0.0-dev-202603120428)
- **OpenCode config:** 8 denied tools (glob, grep, list, task, todowrite, skill, webfetch, websearch, codesearch, external_directory), 4 allowed (bash, read, edit, write)
- **Prompt prefix:** Multi-step reinforcement + /no_think
- **Task:** superlint_demo (3-step tool workflow: check, fix, verify)
- **SIGSEGV:** 0% — ARM64 binary eliminates QEMU emulation instability entirely

## Part A: Ollama Direct API Tool Calling

Tests whether models can produce correct structured tool calls via Ollama's API
(bypassing opencode's system prompt overhead).

| Model               | Quant  | Disk   | Loaded | Tok/s | Correct | Tokens |
|---------------------|--------|--------|--------|-------|---------|--------|
| qwen3:1.7b          | Q4_K_M | 1.4 GB | 1.7 GB | 49.8  | 3/3     | 375    |
| qwen3-4b-q2k        | Q2_K   | 1.7 GB | 2.5 GB | 24.7  | 3/3     | 274    |
| qwen3-4b-q3km       | Q3_K_M | 2.1 GB | 2.9 GB | 22.0  | 3/3     | 303    |
| qwen3:4b (official) | Q4_K_M | 2.5 GB | 3.2 GB | 22.5  | 3/3     | 918    |
| qwen2.5:3b          | Q4_K_M | 1.9 GB | 2.0 GB | 40.8  | 0/3     | 35     |
| phi4-mini (3.8B)    | Q4_K_M | 2.5 GB | 2.8 GB | 34.2  | 0/3     | 91     |
| granite3.3:2b       | Q4_K_M | 1.5 GB | 1.7 GB | 44.4  | 0/3     | 67     |
| llama3.2:3b         | Q4_K_M | 2.0 GB | 2.2 GB | 38.9  | 0/3     | 57     |
| gemma3:4b           | Q4_K_M | 3.3 GB | N/A    | N/A   | N/A     | N/A    |

### Key finding: Only Qwen3 models produce structured tool calls on Ollama.
All non-Qwen3 models either output tool calls as text, hallucinate tool names,
or produce no tool calls at all.

### Custom quantization note
Custom GGUF imports from HuggingFace (unsloth) lose tool support because Ollama doesn't
auto-convert the Jinja2 `tokenizer.chat_template` to its internal Go template format.
**Fix:** Extract the Go template from the official model via `/api/show` and embed it
in the custom Modelfile's `TEMPLATE """..."""` directive.

## Part B: End-to-End OpenCode Tests

Models that pass Part A (Ollama API tool calling) were tested through opencode's
full agent loop.

| Model               | Timeout | Duration | Completed? | Failure Mode |
|---------------------|---------|----------|------------|--------------|
| qwen3:4b Q4_K_M     | 600s    | 600s     | No         | OOM: 3.4 GiB needed, 2.6 GiB available |
| qwen3:1.7b Q4_K_M   | 180s    | 180s     | No         | Prompt eval bottleneck: 107s per iteration |
| qwen3:1.7b minimal  | 120s    | 120s     | No         | Prompt eval bottleneck: 107s per iteration |

### Root cause: Prompt evaluation bottleneck
OpenCode's system prompt (~1500-2000 tokens) takes 107-142 seconds of CPU-only prompt
evaluation per agent loop iteration. A 3-step workflow needs 4+ iterations, totaling
428-600s of prompt eval alone — leaving no time for actual work within the 600s timeout.

See experiment 04 for detailed analysis.

## Conclusions

1. **qwen3:1.7b is the best model candidate** — fastest (50 tok/s), smallest (1.7 GB),
   perfect tool calling (3/3), and respects /no_think (375 vs 918 tokens for same task).

2. **The bottleneck is opencode's system prompt on CPU, not model capability.** Models
   that work in 6 seconds via direct API timeout at 120-600s through opencode.

3. **Custom quants (Q2_K, Q3_K_M) work** but are slower than qwen3:1.7b native Q4_K_M.
   The smaller native model wins on every metric.

4. **8 threads is optimal** on the 12-core Snapdragon X Elite. 10 threads gives no
   improvement; 6 threads is 15-20% slower.

5. **num_ctx 4096 is sufficient** for opencode. The memory overhead vs 2048 is only
   ~0.1 GB, and 8192 causes OOM under memory pressure.
