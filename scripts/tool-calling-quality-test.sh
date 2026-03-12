#!/bin/bash
# Tool-calling quality test for candidate models.
# Tests whether each model can correctly generate the 3-step superlint workflow.
#
# Usage: bash scripts/tool-calling-quality-test.sh

OLLAMA_URL="http://localhost:11434"

MODELS=(
  "qwen3:4b"
  "qwen3:1.7b"
  "qwen2.5:3b"
  "phi4-mini"
  "granite3.3:2b"
  "llama3.2:3b"
  "gemma3:4b"
)

TOOL_DEF='[{
  "type": "function",
  "function": {
    "name": "bash",
    "description": "Run a bash command and return its output",
    "parameters": {
      "type": "object",
      "properties": {
        "command": {"type": "string", "description": "The bash command to execute"}
      },
      "required": ["command"]
    }
  }
}]'

PROMPT="CRITICAL: Execute ALL commands below in order using the bash tool. After each command completes, immediately run the next one.

Run these 3 commands in order:
1. superlint check
2. superlint fix --target app.js
3. superlint verify

Do NOT explain. Just call the tools."

echo "================================================================="
echo "  Tool-Calling Quality Test"
echo "  Date: $(date -Iseconds)"
echo "================================================================="
echo ""

printf "%-20s %8s %12s %8s %s\n" "MODEL" "CALLS" "CORRECT" "TOK/S" "COMMANDS"
printf "%-20s %8s %12s %8s %s\n" "--------------------" "--------" "------------" "--------" "--------"

for model in "${MODELS[@]}"; do
  # Stop any loaded model
  ollama stop "$model" 2>/dev/null
  sleep 1

  RESULT=$(curl -s --max-time 180 "$OLLAMA_URL/api/chat" -d "{
    \"model\": \"$model\",
    \"messages\": [{\"role\": \"user\", \"content\": $(echo "$PROMPT" | python3 -c "import sys,json; print(json.dumps(sys.stdin.read()))")}],
    \"tools\": $TOOL_DEF,
    \"stream\": false,
    \"options\": {
      \"num_predict\": 512,
      \"num_ctx\": 4096,
      \"num_thread\": 8,
      \"temperature\": 0
    }
  }" 2>&1)

  ERROR=$(echo "$RESULT" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('error',''))" 2>/dev/null)

  if [ -n "$ERROR" ]; then
    printf "%-20s %8s %12s %8s %s\n" "$model" "N/A" "N/A" "N/A" "ERROR: $ERROR"
    continue
  fi

  # Parse results
  PARSED=$(echo "$RESULT" | python3 -c "
import sys, json
d = json.load(sys.stdin)
msg = d.get('message', {})
calls = msg.get('tool_calls', [])
content = msg.get('content', '')

eval_count = d.get('eval_count', 0)
eval_ns = d.get('eval_duration', 0)
tok_s = eval_count / (eval_ns / 1e9) if eval_ns > 0 else 0

commands = []
for tc in calls:
    fn = tc.get('function', {})
    args = fn.get('arguments', {})
    cmd = args.get('command', '')
    commands.append(cmd)

# Check correctness
expected = ['superlint check', 'superlint fix --target app.js', 'superlint verify']
correct = 0
for i, exp in enumerate(expected):
    if i < len(commands) and exp in commands[i]:
        correct += 1

cmds_str = ' | '.join(commands) if commands else content[:80].replace('\n', ' ')
print(f'{len(calls)}\t{correct}/3\t{tok_s:.1f}\t{cmds_str}')
" 2>/dev/null)

  NUM_CALLS=$(echo "$PARSED" | cut -f1)
  CORRECT=$(echo "$PARSED" | cut -f2)
  TOK_S=$(echo "$PARSED" | cut -f3)
  CMDS=$(echo "$PARSED" | cut -f4-)

  printf "%-20s %8s %12s %8s %s\n" "$model" "$NUM_CALLS" "$CORRECT" "$TOK_S" "$CMDS"

  ollama stop "$model" 2>/dev/null
  sleep 1
done

echo ""
echo "================================================================="
echo "  Test complete"
echo "================================================================="
