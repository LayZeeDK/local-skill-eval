#!/bin/bash
# Memory & throughput test matrix for opencode agent models.
# Tests each model x num_ctx x num_thread combination.
# Measures: memory estimate, load success, tokens/sec.
#
# Usage: bash scripts/memory-throughput-matrix.sh

OLLAMA_URL="http://localhost:11434"

# Prompt that approximates opencode's system prompt + tool defs + user instruction
# (~1500 tokens input to stress the KV cache)
TEST_PROMPT="You are an AI coding assistant. You have tools: Bash, Read, Edit, Write. Run superlint check to identify issues in app.js. Then run superlint fix --target app.js. Then run superlint verify. Respond with the tool calls needed. Be concise."

# Models to test (must exist locally)
MODELS=(
  "qwen3:4b"
  "qwen3:1.7b"
  "qwen2.5:3b"
)

# Context sizes to test
CTX_SIZES=(2048 4096 8192)

# Thread counts to test
THREADS=(6 8 10)

# num_predict for consistent measurement
NUM_PREDICT=128

echo "================================================================="
echo "  Memory & Throughput Matrix Test"
echo "  Date: $(date -Iseconds)"
echo "================================================================="
echo ""

# Header
printf "%-20s %8s %8s %10s %10s %10s %8s\n" \
  "MODEL" "CTX" "THREADS" "MEM(GB)" "LOAD(s)" "TOK/S" "STATUS"
printf "%-20s %8s %8s %10s %10s %10s %8s\n" \
  "--------------------" "--------" "--------" "----------" "----------" "----------" "--------"

for model in "${MODELS[@]}"; do
  for ctx in "${CTX_SIZES[@]}"; do
    for threads in "${THREADS[@]}"; do
      # Stop any loaded model first
      ollama stop "$model" 2>/dev/null
      sleep 1

      # Try to load and generate
      START_TIME=$(date +%s%N)
      RESULT=$(curl -s --max-time 120 "$OLLAMA_URL/api/chat" -d "{
        \"model\": \"$model\",
        \"messages\": [{\"role\": \"user\", \"content\": \"$TEST_PROMPT\"}],
        \"stream\": false,
        \"options\": {
          \"num_predict\": $NUM_PREDICT,
          \"num_ctx\": $ctx,
          \"num_thread\": $threads,
          \"temperature\": 0
        }
      }" 2>&1)
      END_TIME=$(date +%s%N)

      # Check for error
      ERROR=$(echo "$RESULT" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('error',''))" 2>/dev/null)

      if [ -n "$ERROR" ]; then
        printf "%-20s %8d %8d %10s %10s %10s %8s\n" \
          "$model" "$ctx" "$threads" "N/A" "N/A" "N/A" "OOM"
        continue
      fi

      # Parse timing from Ollama response
      LOAD_NS=$(echo "$RESULT" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('load_duration',0))" 2>/dev/null)
      EVAL_COUNT=$(echo "$RESULT" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('eval_count',0))" 2>/dev/null)
      EVAL_NS=$(echo "$RESULT" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('eval_duration',0))" 2>/dev/null)
      PROMPT_COUNT=$(echo "$RESULT" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('prompt_eval_count',0))" 2>/dev/null)
      PROMPT_NS=$(echo "$RESULT" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('prompt_eval_duration',0))" 2>/dev/null)

      # Calculate metrics
      LOAD_S=$(python3 -c "print(f'{$LOAD_NS / 1e9:.1f}')")
      if [ "$EVAL_NS" -gt 0 ] 2>/dev/null; then
        TOK_S=$(python3 -c "print(f'{$EVAL_COUNT / ($EVAL_NS / 1e9):.1f}')")
      else
        TOK_S="N/A"
      fi

      # Get memory from ollama ps
      MEM=$(ollama ps 2>/dev/null | rg "$model" | awk '{print $3}')

      printf "%-20s %8d %8d %10s %10s %10s %8s\n" \
        "$model" "$ctx" "$threads" "$MEM" "$LOAD_S" "$TOK_S" "[OK]"

      # Stop model to free memory for next test
      ollama stop "$model" 2>/dev/null
      sleep 1
    done
  done
done

echo ""
echo "================================================================="
echo "  Test complete"
echo "================================================================="
