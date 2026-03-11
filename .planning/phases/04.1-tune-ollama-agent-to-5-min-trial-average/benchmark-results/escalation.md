# Benchmark: Escalation (Plan 03)

**Date:** 2026-03-11
**Purpose:** Context pruning + alternative model exploration to reduce path variance and improve performance beyond Plan 02's parameter tuning.

## Experiments

### 1. Context Pruning (qwen3.5:4b + pruneHistory)

Added `pruneHistory()` to `src/agents/ollama/index.ts` — keeps system prompt, user instruction, and last 3 turn groups; replaces older messages with a summary marker. Goal: reduce prompt_eval_duration on later turns.

**Configuration:** Same as baseline (qwen3.5:4b, num_batch 1024, temp 0) + pruning enabled.

| Trial | Duration (s) | Reward | Commands |
|-------|-------------|--------|----------|
| 1 | 206.7 | 1.00 | 4 |
| 2 | 251.7 | 0.97 | 4 |
| 3 | 295.4 | 1.00 | 5 |
| **Avg** | **251.3** | **0.99** | **4.3** |
| **StdDev** | **38.4** | -- | -- |

**Verdict:** Higher variance than baseline (38.4s vs 9.4s). Trial 3 took a 5-command path (295s). Context pruning does not clearly help — the thinking model may rely on earlier context to avoid redundant tool calls. Kept in codebase but not a performance win.

### 2. qwen3.5:4b-q8_0 (higher quantization)

Same architecture, Q8_0 quantization (5.3GB vs 3.4GB Q4_K_M). Higher precision weights = potentially better tool call decisions at the cost of more memory and slower per-token inference.

**Configuration:** qwen3.5:4b-q8_0, num_ctx 4096, num_predict 4096, temp 0, num_batch 1024, num_thread 8.

| Trial | Duration (s) | Reward | Commands |
|-------|-------------|--------|----------|
| 1 | 160.6 | 0.97 | 4 |
| 2 | 175.8 | 0.97 | 4 |
| 3 | 171.9 | 0.97 | 4 |
| **Avg** | **169.4** | **0.97** | **4.0** |
| **StdDev** | **10.1** | -- | -- |

**Confirmation run (3 trials):**

| Trial | Duration (s) | Reward | Commands |
|-------|-------------|--------|----------|
| 1 | 166.5 | 0.97 | 4 |
| 2 | 165.0 | 0.97 | 4 |
| 3 | 162.8 | 0.97 | 4 |
| **Avg** | **164.8** | **0.97** | **4.0** |
| **StdDev** | **1.9** | -- | -- |

**6-trial combined:** avg 167.1s +/- 7.3s, reward 0.97, 4 cmds.

**Verdict:** Excellent. 28% faster than baseline, very low variance, consistent 4-command golden path. The Q8_0 precision helps the model make faster/better decisions despite slower per-token generation. Model size (5.3GB) fits locally (32GB RAM) and in CI (16GB, sequential with grader). **Runner-up.**

### 3. qwen3:4b (old model with tuned params)

The model we migrated away from in Plan 01. Re-tested with Plan 02's best parameters (num_batch 1024).

**Configuration:** qwen3:4b, num_ctx 4096, num_predict 4096, temp 0, num_batch 1024, num_thread 8.

| Trial | Duration (s) | Reward | Commands |
|-------|-------------|--------|----------|
| warmup | ETIMEDOUT | -- | -- |
| 1 | 310.5 | 0.00 | 0 |
| 2 (aborted) | -- | -- | -- |

**Verdict:** Failed. Warmup timed out (>600s), Trial 1 completed with reward=0 and 0 commands. ~20 min per trial. The model cannot complete the task even with tuned parameters. **Rejected.**

### 4. qwen2.5:7b (non-thinking, 7.6B params)

Larger non-thinking model. Q4_K_M quantization, 4.7GB. Has tool-calling capability but no chain-of-thought reasoning.

**Configuration:** qwen2.5:7b, num_ctx 4096, num_predict 4096, temp 0, num_batch 1024, num_thread 8. System prompt includes `/no_think` (ignored by non-thinking model, harmless).

| Trial | Duration (s) | Reward | Commands |
|-------|-------------|--------|----------|
| 1 | 242.6 | 0.00 | 25 |
| 2 | 241.2 | 0.00 | 25 |
| 3 | 240.7 | 0.00 | 25 |
| **Avg** | **241.5** | **0.00** | **25** |
| **StdDev** | **1.0** | -- | -- |

**Verdict:** Catastrophic failure. Reward=0, 25 commands (near maxIterations=30). The 7B model loops endlessly making wrong tool calls — it cannot reason about when to stop. Fast per-token (241s for 25 commands) but completely incapable. **Rejected.**

### 5. qwen2.5:3b (non-thinking, 3B params)

Smallest model tested. Same architecture as qwen2.5:7b but 2.5x fewer parameters. Q4_K_M quantization, 1.9GB. Already installed as the LLM grader model.

**Configuration:** qwen2.5:3b, num_ctx 4096, num_predict 4096, temp 0, num_batch 1024, num_thread 8. System prompt includes `/no_think` (ignored, harmless).

| Trial | Duration (s) | Reward | Commands |
|-------|-------------|--------|----------|
| 1 | 64.1 | 1.00 | 3 |
| 2 | 63.6 | 1.00 | 3 |
| 3 | 63.4 | 1.00 | 3 |
| **Avg** | **63.7** | **1.00** | **3.0** |
| **StdDev** | **0.4** | -- | -- |

**Validation run (5 trials):**

| Trial | Duration (s) | Reward | Commands |
|-------|-------------|--------|----------|
| 1 | 63.8 | 1.00 | 3 |
| 2 | 60.9 | 1.00 | 3 |
| 3 | 61.1 | 1.00 | 3 |
| 4 | 61.1 | 1.00 | 3 |
| 5 | 60.5 | 1.00 | 3 |
| **Avg** | **61.5** | **1.00** | **3.0** |
| **StdDev** | **1.3** | -- | -- |

**8-trial combined:** avg 62.3s +/- 1.3s, reward 1.00, 3 cmds.

**Verdict:** Extraordinary. 3.8x faster than baseline, perfect reward, zero variance in command count, near-zero duration variance. Solves the task in 3 commands (one fewer than qwen3.5:4b's "golden path" of 4). The smallest model tested is the best performer — it doesn't overthink, just emits the correct tool calls directly. Shares the same base blob as the grader (zero additional disk for agent model). **Winner.**

## Results

### Complete Scoreboard

| Model | Params | Quant | Size | Trials | Avg (s) | StdDev | Reward | Cmds | Verdict |
|-------|--------|-------|------|--------|---------|--------|--------|------|---------|
| **qwen2.5:3b** | **3B** | **Q4_K_M** | **1.9GB** | **8** | **62.3** | **1.3** | **1.00** | **3** | **Winner** |
| qwen3.5:4b-q8_0 | 4B | Q8_0 | 5.3GB | 6 | 167.1 | 7.3 | 0.97 | 4 | Alternative |
| qwen3.5:4b | 4B | Q4_K_M | 3.4GB | 3 | 235.0 | 9.4 | 0.99 | 4 | Baseline |
| qwen3.5:4b+pruning | 4B | Q4_K_M | 3.4GB | 3 | 251.3 | 38.4 | 0.99 | 4.3 | Worse |
| qwen2.5:7b | 7.6B | Q4_K_M | 4.7GB | 3 | 241.5 | 1.0 | 0.00 | 25 | Failed |
| qwen3:4b | 4B | Q4_K_M | 2.5GB | ~1 | 310+ | -- | 0.00 | 0 | Failed |

### Key Findings

1. **Model size is not correlated with agent quality.** The smallest model (3B) outperformed all larger models. The largest model tested (7.6B) failed completely.

2. **Thinking capability is a double-edged sword.** qwen3.5:4b (thinking) takes 4 commands with CoT overhead. qwen2.5:3b (non-thinking) takes 3 commands with zero reasoning overhead. For well-defined tool-use tasks, direct action beats deliberation.

3. **Quantization matters for thinking models.** qwen3.5:4b-q8_0 was 28% faster than qwen3.5:4b-q4 — higher precision weights improve tool call decision quality in thinking models.

4. **Context pruning adds variance without clear benefit.** The thinking model appears to use earlier context to avoid redundant calls. Pruning removes that signal, occasionally causing extra commands.

5. **Same architecture, different sizes, wildly different outcomes.** qwen2.5:3b (reward=1.00, 3 cmds) vs qwen2.5:7b (reward=0.00, 25 cmds). The 7B model loops; the 3B model doesn't. Likely a training data or fine-tuning difference in tool-calling behavior.

### Configuration Details

**Winner: qwen2.5:3b**

Modelfile (`modelfiles/qwen2.5-3b-skill-eval-agent.Modelfile`):
```
FROM qwen2.5:3b
PARAMETER num_ctx 4096
PARAMETER num_predict 4096
PARAMETER temperature 0
PARAMETER num_batch 1024
PARAMETER num_thread 8
```

Agent config (`src/agents/ollama/types.ts`):
```typescript
model: 'qwen2.5-3b-skill-eval-agent'
```

System prompt (`src/agents/ollama/index.ts`):
```
You are an AI agent that completes coding tasks. Use the provided tools to complete the task.
Do not explain your reasoning - just call the appropriate tool.
When you are done, respond with a summary of what you did. /no_think
```

Note: `/no_think` is a qwen3.5 directive ignored by qwen2.5. Should be removed for clarity but is harmless.

API call changes for non-thinking model:
- Remove `think: false` from `this.client.chat()` options (qwen2.5 doesn't support this parameter)

Context pruning: Retained in code but effectively unused — qwen2.5:3b completes in 3 commands, never reaching the pruning threshold (2 + 3*3 = 11 messages).

**Alternative: qwen3.5:4b-q8_0**

Modelfile (`modelfiles/qwen3.5-q8_0-skill-eval-agent.Modelfile`):
```
FROM qwen3.5:4b-q8_0
PARAMETER num_ctx 4096
PARAMETER num_predict 4096
PARAMETER temperature 0
PARAMETER num_batch 1024
PARAMETER num_thread 8
```

Use if: qwen2.5:3b fails on harder tasks that require chain-of-thought reasoning. The thinking model with Q8_0 quantization is 2.7x slower but handles complex multi-step tasks where deliberation helps.

### CI Considerations

- **qwen2.5:3b (1.9GB):** Same model as grader. Agent + grader share the same base blob. Minimal disk and RAM overhead in CI. num_thread should be 3 for CI runners (2-core).
- **qwen3.5:4b-q8_0 (5.3GB):** Fits on 16GB CI runner with sequential model loading. Larger but viable.

## Verdict

**qwen2.5:3b is the production agent model.** It delivers 62.3s average (4.8x under the 300s target), perfect reward, and rock-solid consistency across 8 trials. The 5-minute target is not just met — it's exceeded by a factor of 4.8x.

**qwen3.5:4b-q8_0 is the documented alternative** for tasks requiring thinking capability. It delivers 167s average with 0.97 reward.
