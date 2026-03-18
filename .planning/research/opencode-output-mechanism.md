# Research: opencode `run` Command Output Mechanism

**Researched:** 2026-03-16
**Source:** opencode source at `D:\projects\github\sst\opencode` (local checkout)
**Confidence:** HIGH (direct source code analysis)

## Executive Summary

The zero-output hang on ARM64 Linux (piped stdio) is caused by **`Bun.stdin.text()` blocking indefinitely when stdin is a pipe redirected from a file**. This is the root cause. The output mechanism itself is well-designed and writes to both stdout and stderr, but execution never reaches the LLM call because the process stalls on stdin consumption.

## 1. How `opencode run` Writes Output

### Two output channels with distinct purposes

| Channel | What goes there | When |
|---------|----------------|------|
| **stderr** | All UI chrome: tool calls, status, logos, errors | Always (via `UI.print`/`UI.println`) |
| **stdout** | Final assistant text responses only | When `!process.stdout.isTTY` (pipe mode) |
| **stdout** | JSON event stream | When `--format=json` |

**Key code** (`run.ts` lines 496-506):
```typescript
if (part.type === "text" && part.time?.end) {
  if (emit("text", { part })) continue  // JSON mode -> stdout
  const text = part.text.trim()
  if (!text) continue
  if (!process.stdout.isTTY) {
    process.stdout.write(text + EOL)  // Pipe mode -> stdout
    continue
  }
  UI.empty()          // TTY mode -> stderr (via UI.println)
  UI.println(text)
  UI.empty()
}
```

When stdout is NOT a TTY (piped), assistant text goes to `process.stdout.write()`. When stdout IS a TTY, assistant text goes to `UI.println()` which writes to `process.stderr`. Tool call progress always goes to stderr regardless.

### The `emit()` function for JSON format

When `--format=json`, ALL events (tool_use, text, step_start, step_finish, errors) are written to stdout as newline-delimited JSON via `process.stdout.write()`.

## 2. The Stdin Blocking Problem (ROOT CAUSE)

**Line 345 of `run.ts`:**
```typescript
if (!process.stdin.isTTY) message += "\n" + (await Bun.stdin.text())
```

This is executed BEFORE any LLM call, session creation, or event subscription. The flow is:

1. Parse CLI args
2. **If stdin is not a TTY** -> `await Bun.stdin.text()` (BLOCKS HERE)
3. Validate message is non-empty
4. Bootstrap instance (DB, plugins, LSP, file watcher)
5. Create SDK client
6. Subscribe to events
7. Send prompt to LLM
8. Stream results

`Bun.stdin.text()` reads ALL of stdin until EOF. With `< /tmp/.prompt.md`, this should work -- the shell opens the file, provides its contents, then signals EOF. However, **this is Bun-specific behavior** and Bun's stdin handling on ARM64 Linux may have edge cases.

### Why it works with TTY (Docker with `-t`)

When Docker allocates a pseudo-TTY (`-t` flag), `process.stdin.isTTY` is `true`, so the `Bun.stdin.text()` call is **skipped entirely**. The message comes purely from the CLI positional args. This explains why Docker (with TTY) works but piped stdio (without TTY) hangs.

### Why it works on x86_64 but not ARM64

Bun on ARM64 Linux may have a bug in its stdin pipe handling. The `Bun.stdin.text()` call uses Bun's internal I/O event loop, not Node.js's. If Bun's event loop on ARM64 fails to detect EOF on a redirected file descriptor, `text()` would wait forever.

## 3. TTY Detection Summary

opencode checks `isTTY` in three places within `run.ts`:

| Check | Line | Effect |
|-------|------|--------|
| `process.stdin.isTTY` | 345 | If false: reads ALL stdin via `Bun.stdin.text()` |
| `process.stdout.isTTY` | 500 | If false: writes assistant text to stdout (not stderr) |
| `process.stdout.isTTY` | 514 | If true: writes reasoning to stderr via UI |

There is NO explicit "suppress output in non-TTY mode" logic. Both TTY and non-TTY modes produce output -- just to different file descriptors.

## 4. Bun-Specific APIs

Only one Bun-specific API is used in the `run` command:

- **`Bun.stdin.text()`** (line 345) -- reads entire stdin as a string. This is the Bun equivalent of reading `process.stdin` to completion. Node.js would use `process.stdin` with stream events.

The rest of the output uses standard `process.stdout.write()` and `process.stderr.write()`, which are Node.js-compatible APIs that Bun also supports.

## 5. AI SDK Streaming

The `run` command uses the opencode SDK client which calls `POST /session/{sessionID}/message`. This is a **synchronous streaming endpoint** -- it waits for the full LLM response before returning. The server uses Hono's `stream()` helper.

Internally, the AI SDK (`@ai-sdk/openai-compatible`) uses streaming by default when calling the LLM. The server emits events via SSE (`Bus.subscribeAll`) as the LLM streams tokens. The `run` command's `loop()` function consumes these SSE events via `sdk.event.subscribe()`.

The LLM call itself would not hang indefinitely because:
- `@ai-sdk/openai-compatible` has built-in fetch timeouts
- The server uses Hono streaming with abort handling

However, **none of this matters** because execution never reaches the LLM call -- it stalls on `Bun.stdin.text()`.

## 6. Architecture of the Run Command

```
CLI args + stdin
       |
       v
[Bun.stdin.text()]  <-- BLOCKS HERE in pipe mode on ARM64
       |
       v
[bootstrap()]  -- init DB, plugins, LSP, file watcher
       |
       v
[Server.Default().fetch]  -- in-process Hono server (no TCP)
       |
       v
[sdk.event.subscribe()]  -- SSE event stream
       |
       v
[sdk.session.prompt()]  -- POST /session/{id}/message
       |
       v
[SessionPrompt.prompt()]  -- calls AI SDK -> Ollama
       |
       v
[Bus events]  -- streamed back via SSE
       |
       v
[loop() processes events]  -- writes to stdout/stderr
```

Note: When not using `--attach`, the SDK client uses an **in-process fetch** that calls `Server.Default().fetch()` directly -- no TCP socket, no HTTP. This is efficient but means the server and client share the same Bun event loop.

## 7. Recommended Fix

### Option A: Bypass Bun.stdin.text() (RECOMMENDED)

Instead of piping via stdin, pass the prompt as a CLI argument or via `--file`:

```bash
# Instead of:
opencode run "prompt" < /tmp/.prompt.md

# Use:
prompt_content=$(cat /tmp/.prompt.md)
opencode run "$prompt_content"

# Or use --file flag (but this attaches as a file, not inline text):
opencode run "See attached" --file /tmp/.prompt.md
```

This avoids `Bun.stdin.text()` entirely because `process.stdin.isTTY` would be true (or stdin is not relevant).

### Option B: Use a FIFO with explicit EOF

```bash
# Write to a FIFO and close it to ensure EOF
mkfifo /tmp/.prompt.fifo
cat /tmp/.prompt.md > /tmp/.prompt.fifo &
opencode run "" < /tmp/.prompt.fifo
rm /tmp/.prompt.fifo
```

### Option C: Allocate a pseudo-TTY for stdin only

Use `script` or `unbuffer` to give stdin a TTY while keeping stdout/stderr as pipes. This makes `isTTY` true and skips `Bun.stdin.text()`, but the prompt must then come from CLI args.

### Option D: Use --format=json

If the issue is specifically about capturing output, `--format=json` writes everything to stdout as structured JSON regardless of TTY state.

## 8. Why Docker Works

The Docker invocation likely uses `-t` (allocate pseudo-TTY), which makes:
- `process.stdin.isTTY` = true -> skips `Bun.stdin.text()`
- `process.stdout.isTTY` = true -> assistant text goes to stderr via `UI.println`

The 700+ bytes of stdout in Docker is likely the TTY control sequences and text that Docker's TTY multiplexing captures, or it could be that Docker is using `--format=json`.

## Sources

All findings from direct source code analysis:
- `packages/opencode/src/cli/cmd/run.ts` -- main run command (677 lines)
- `packages/opencode/src/cli/ui.ts` -- UI output helpers (write to stderr)
- `packages/opencode/src/cli/bootstrap.ts` -- instance initialization
- `packages/opencode/src/project/bootstrap.ts` -- full bootstrap sequence
- `packages/opencode/src/server/server.ts` -- SSE event streaming
- `packages/opencode/src/server/routes/session.ts` -- prompt endpoints
- `packages/opencode/src/provider/provider.ts` -- AI SDK provider setup
- `packages/sdk/js/src/v2/gen/sdk.gen.ts` -- SDK client methods
