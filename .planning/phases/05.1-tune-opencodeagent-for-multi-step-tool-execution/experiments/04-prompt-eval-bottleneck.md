# Experiment 04: Prompt Evaluation Bottleneck Analysis

## Objective

Diagnose why models that produce correct tool calls via Ollama API (6 seconds)
time out through opencode (600 seconds).

## Root Cause

**Prompt evaluation of opencode's system prompt takes 107-142 seconds per agent loop
iteration on CPU-only inference.**

OpenCode injects a large system prompt containing:
- Safety and behavior instructions (~500 tokens)
- Tool definitions with full JSON schemas (~800+ tokens)
- Permission rules, skill descriptions (~200+ tokens)
- Project context, git info (~200+ tokens)
- Total: ~1500-2000 tokens of system prompt per request

On CPU-only inference with qwen3:1.7b at ~14 tokens/second prompt eval rate,
processing 1500 tokens takes ~107 seconds before the first output token.

## Evidence

### Timeline Analysis (from stderr logs)

**Default agent (all tools):**
| Event | Timestamp | Delta |
|-------|-----------|-------|
| LLM stream started | 20:36:27 | 0s |
| First token generated | 20:38:49 | 142s |
| Step 1 loop | 20:39:07 | 160s |
| Timeout | 20:39:27 | 180s |

**Minimal agent (4 tools: bash, read, edit, write):**
| Event | Timestamp | Delta |
|-------|-----------|-------|
| LLM stream started | 20:43:17 | 0s |
| First token generated | 20:45:04 | 107s |
| Timeout | 20:45:17 | 120s |

Minimal agent saves ~35 seconds (fewer tool definitions) but the core system prompt
(~1500 tokens) is still dominant.

### Comparison: Direct Ollama API vs OpenCode

| Metric | Direct Ollama API | Through OpenCode |
|--------|-------------------|------------------|
| System prompt tokens | ~20 | ~1500-2000 |
| Prompt eval time | <1s | 107-142s |
| Token generation | ~7s | ~18s |
| Total for 3 tool calls | ~8s | >120s (timeout) |
| Tool calls correct | 3/3 | 0/3 (never completes) |

## Why This Is Fundamental

Each opencode agent loop iteration resends the FULL conversation context:
1. System prompt (~1500 tokens) — processed every time
2. Previous messages (grows with each tool call result)
3. New user/tool response

For a 3-step workflow (check, fix, verify), the agent needs at minimum:
- Step 0: Generate first tool call = 107-142s prompt eval + 18s generation
- Step 1: Generate second tool call = 107+ prompt eval (now with tool result) + 18s
- Step 2: Generate third tool call = 107+ prompt eval (even longer context) + 18s
- Step 3: Generate summary = 107+ prompt eval + generation

**Minimum total: 4 * 107s = 428s of prompt eval alone** — leaving only 172s in a 600s
timeout for token generation and tool execution.

In practice, each subsequent iteration has MORE prompt tokens (accumulated tool results),
making later iterations slower. A 3-step workflow likely needs 500-600s total.

## Why the Minimal Agent Didn't Help Enough

The minimal agent reduces tool definitions from ~12 to 4, saving ~35 seconds.
But the core system prompt (safety instructions, opencode behavior, permissions,
skill descriptions) is injected by opencode regardless of agent config.

Estimated prompt composition (minimal agent):
- Core system prompt: ~1000 tokens (not configurable)
- 4 tool definitions with schemas: ~300 tokens
- Agent custom instructions: ~50 tokens
- User message: ~100 tokens
- Total: ~1450 tokens = ~103 seconds at 14 tok/s

vs. default agent:
- Core system prompt: ~1000 tokens
- 12+ tool definitions with schemas: ~800 tokens
- Skills documentation: ~200 tokens
- User message: ~100 tokens
- Total: ~2100 tokens = ~150 seconds at 14 tok/s

## Implications for Local LLM + OpenCode

**CPU-only inference with small models (1.7B-4B) is fundamentally incompatible with
opencode's prompt-heavy architecture.**

The performance ceiling is set by prompt evaluation throughput:

| Model | Prompt Eval Rate | Time for 1500 tokens | Budget for 3-step (600s) |
|-------|-----------------|---------------------|--------------------------|
| qwen3:1.7b | ~14 tok/s | 107s | Barely fits (428s eval) |
| qwen3:4b | ~7 tok/s | 214s | Does not fit (856s eval) |

Even the fastest small model (qwen3:1.7b) leaves no margin for error in a 600s timeout.

## Alternatives

### 1. Bypass OpenCode — Direct Ollama API Agent
Use the existing OllamaToolAgent pattern (Phase 4.1) but with multi-turn tool calling.
The system prompt would be ~100 tokens (not 1500+), making prompt eval <1 second.

**Pro:** Fastest option, proven 3/3 tool accuracy, 6-second completion
**Con:** Loses opencode's tool execution sandbox, file editing, agent loop

### 2. Increase Timeout
Set timeout to 900-1200s. Would allow qwen3:1.7b to complete the full workflow.

**Pro:** Simplest change, uses opencode as-is
**Con:** Very slow trials (15-20 min each), defeats the "5-minute average" goal

### 3. Docker Provider
Run opencode inside a Docker container with native linux-arm64 inference.
The Docker container has proper NEON SIMD support for faster prompt eval.

**Pro:** Potentially 2-3x faster prompt eval, zero SIGSEGV
**Con:** Docker startup overhead, complexity, x86_64 emulation for opencode

### 4. Ollama Prompt Caching
Ollama has experimental prompt caching via `num_keep` parameter.
If the system prompt is cached, subsequent iterations skip prompt eval for the
static prefix, dramatically reducing iteration time.

**Pro:** Could reduce prompt eval to ~10s per iteration
**Con:** Requires careful `num_keep` tuning, may not work through OpenCode

### 5. Reduce OpenCode System Prompt
Fork or configure opencode to use a minimal system prompt for local LLM use.

**Pro:** Addresses root cause directly
**Con:** Requires opencode source changes, fragile to upstream updates
