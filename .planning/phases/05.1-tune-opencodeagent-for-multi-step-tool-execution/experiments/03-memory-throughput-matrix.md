# Experiment 03: Memory, Throughput & Tool-Calling Matrix

## Objective

Identify the optimal model configuration for the OpenCode agent, balancing:
- Memory footprint (must fit under ~2.6 GiB when Claude Code is running)
- CPU throughput (8 threads optimal on 12-core Snapdragon X Elite)
- Tool-calling quality (3/3 correct superlint workflow calls)

## Root Cause of 600s Timeouts

**The original timeout was caused by OOM, not model incapability.**

Ollama reported "model requires more system memory (3.4 GiB) than is available (2.6 GiB)" for
qwen3:4b at num_ctx 8192. OpenCode retried with exponential backoff (352ms -> 2s -> 33s intervals)
until the 600s eval timeout killed the process. Additionally, OpenCode fires a parallel
title-generation LLM call alongside the main prompt, doubling initial memory demand.

## Memory & Throughput Matrix (8 threads, 4096 ctx)

| Model               | Quant  | Disk   | Loaded | Tok/s | Tool Calls | Tokens Used |
|---------------------|--------|--------|--------|-------|------------|-------------|
| qwen3:1.7b          | Q4_K_M | 1.4 GB | 1.7 GB | 49.8  | 3/3        | 375         |
| qwen3-4b-q2k        | Q2_K   | 1.7 GB | 2.5 GB | 24.7  | 3/3        | 274         |
| qwen3-4b-q3km       | Q3_K_M | 2.1 GB | 2.9 GB | 22.0  | 3/3        | 303         |
| qwen3:4b (official)  | Q4_K_M | 2.5 GB | 3.2 GB | 22.5  | 3/3        | 918         |
| qwen2.5:3b          | Q4_K_M | 1.9 GB | 2.0 GB | 40.8  | 0/3        | 35          |
| phi4-mini (3.8B)    | Q4_K_M | 2.5 GB | 2.8 GB | 34.2  | 0/3        | 91          |
| granite3.3:2b       | Q4_K_M | 1.5 GB | 1.7 GB | 44.4  | 0/3        | 67          |
| llama3.2:3b         | Q4_K_M | 2.0 GB | 2.2 GB | 38.9  | 0/3        | 57          |
| gemma3:4b           | Q4_K_M | 3.3 GB | N/A    | N/A   | N/A        | N/A         |

gemma3:4b does not support tools on Ollama.

## Thread Count Comparison (qwen3:4b, 4096 ctx)

| Threads | Tok/s |
|---------|-------|
| 6       | 24.4  |
| 8       | 27.4  |
| 10      | 27.6  |

8 threads is the sweet spot. 10 threads gives negligible improvement (<1%).

## Context Size Impact (qwen3:4b, 8 threads)

| num_ctx | Loaded Memory | Tok/s |
|---------|---------------|-------|
| 2048    | 3.1 GB        | 28.7  |
| 4096    | 3.2 GB        | 27.4  |
| 8192    | 3.5 GB        | 28.6  |

Context size has minimal impact on throughput but ~0.4 GB memory impact.

## Key Findings

### 1. Only Qwen3 produces structured tool calls on Ollama

All non-Qwen3 models failed at tool calling:
- **phi4-mini**: Output tool calls as raw JSON text instead of structured responses
- **granite3.3:2b**: Silent failure, no tool calls or meaningful content
- **llama3.2:3b**: No tool calls produced
- **qwen2.5:3b**: Hallucinated tool name ("supplemental-linter" instead of "superlint")
- **gemma3:4b**: Ollama reports "does not support tools"

This is a Qwen3-specific advantage — Ollama's tool-calling implementation works best with Qwen3's
Hermes-style function calling format.

### 2. qwen3:1.7b is paradoxically better than qwen3:4b

| Metric          | qwen3:1.7b | qwen3:4b |
|-----------------|------------|----------|
| Tool accuracy   | 3/3        | 3/3      |
| Tok/s           | 49.8       | 22.5     |
| Total tokens    | 375        | 918      |
| Thinking tokens | ~0         | ~700     |
| Wall time       | ~7.5s      | ~41s     |
| Loaded memory   | 1.7 GB     | 3.2 GB   |

qwen3:1.7b respects `/no_think` better, producing tool calls immediately without verbose
chain-of-thought. qwen3:4b wastes ~700 tokens on thinking before making the same calls.

### 3. Custom quantization works but requires template injection

Ollama's GGUF import doesn't auto-convert Jinja2 `tokenizer.chat_template` to its Go template
format. Custom GGUFs get `{{ .Prompt }}` (generic passthrough) which disables tool support.

**Fix:** Extract the Go template from the official model and embed it in the Modelfile:
```
curl -s http://localhost:11434/api/show -d '{"name":"qwen3:4b"}' | jq -r '.template' > template.txt
# Add TEMPLATE """...""" to Modelfile
```

### 4. Custom quants of qwen3:4b are slower than qwen3:1.7b

| Model           | Loaded | Tok/s | Memory fits 2.6 GiB? |
|-----------------|--------|-------|------------------------|
| qwen3:1.7b      | 1.7 GB | 49.8  | Yes                    |
| qwen3-4b-q2k    | 2.5 GB | 24.7  | Borderline             |
| qwen3-4b-q3km   | 2.9 GB | 22.0  | No                     |
| qwen3:4b Q4_K_M | 3.2 GB | 22.5  | No                     |

Even Q2_K of qwen3:4b (2.5 GB loaded) is slower and uses more memory than qwen3:1.7b Q4_K_M
(1.7 GB loaded). The smaller native model wins on every metric.

## Recommendation

**Primary: qwen3:1.7b** — Best on every metric (speed, memory, tool quality). Create a
`qwen3-1.7b-opencode-agent` Modelfile variant with num_thread 8.

**Fallback: qwen3-4b-q2k** — If 1.7B proves too limited for complex multi-turn tool chains,
the Q2_K quant of 4B provides 4B reasoning in a smaller footprint. Requires Go template injection
in the Modelfile.

**Not recommended:**
- qwen3:4b Q4_K_M — OOMs under memory pressure (3.2 GB loaded)
- All non-Qwen3 models — 0/3 tool-calling accuracy on Ollama
