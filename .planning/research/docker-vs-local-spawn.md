# Research: Docker exec (TTY) vs Node.js spawn (pipes) -- Why Bun/opencode Works in Docker but Hangs Locally

**Researched:** 2026-03-16
**Overall confidence:** HIGH (multiple independent sources corroborate)

---

## Executive Summary

The opencode CLI (built on Bun) completes in ~20s inside Docker but hangs for 150s with zero output when spawned locally via Node.js `child_process.spawn`. The root cause is a combination of **TTY allocation differences** and **opencode's own stdin/permission handling behavior** that together create a deadlock when stdin is a pipe rather than a terminal.

The Docker provider allocates a pseudo-TTY (`Tty: true`) for every exec, which means processes inside the container see `process.stdin.isTTY === true` and `process.stdout.isTTY === true`. The local provider uses Node.js `spawn` with default stdio (pipes), so the child sees `process.stdin.isTTY === undefined` and `process.stdout.isTTY === undefined`.

This distinction triggers at least three interacting failure modes in Bun/opencode.

---

## Finding 1: TTY vs Pipe -- Behavioral Differences

**Confidence: HIGH** (Node.js official docs, Docker docs, Bun release notes)

### What Docker `Tty: true` does

When `docker exec` is called with `Tty: true` (docker.ts line 247-248):

```typescript
const exec = await container.exec({
    Cmd: ['/bin/bash', '-c', command],
    AttachStdout: true,
    AttachStderr: true,
    Tty: true,     // <-- allocates a pseudo-TTY
    Env: envPairs
});
```

Docker allocates a pseudo-TTY (pty) for the exec session. This means:
- The process gets a controlling terminal
- `process.stdin.isTTY === true` inside the container
- `process.stdout.isTTY === true` inside the container
- stdout writes are **synchronous and blocking** (guaranteed flush)
- The process is a **session leader** with its own session/process group
- Line buffering is the default (not full buffering)

### What Node.js `spawn` with default stdio does

The local provider (local.ts line 134):

```typescript
const child = spawn(bashPath, args, {
    cwd: workspacePath,
    env: childEnv,
    // no stdio option = defaults to ['pipe', 'pipe', 'pipe']
});
```

Default `stdio: 'pipe'` means:
- Three new pipe file descriptors are created
- `process.stdin.isTTY === undefined` in the child
- `process.stdout.isTTY === undefined` in the child
- stdout writes are **asynchronous and non-blocking** on POSIX
- The child **inherits the parent's process group** (not a new session)
- Full buffering may apply (libc detects non-TTY stdout)

### Critical differences table

| Aspect | Docker exec (Tty:true) | spawn (pipes) |
|--------|----------------------|---------------|
| `process.stdin.isTTY` | `true` | `undefined` |
| `process.stdout.isTTY` | `true` | `undefined` |
| stdout write mode (POSIX) | Synchronous/blocking | Asynchronous/non-blocking |
| Buffering | Line-buffered | Fully buffered |
| Controlling terminal | Yes (pty) | No |
| Session/process group | New session (session leader) | Inherited from parent |
| Signal delivery on terminal close | SIGHUP to session | No terminal to close |

---

## Finding 2: opencode `run` Hangs Without TTY -- Known Issue

**Confidence: HIGH** (GitHub issues #5888, #10411, #4506, #8203 directly describe this)

This is the **primary cause** of the hang. opencode has a well-documented history of hanging indefinitely when run in non-interactive (non-TTY) environments:

### The permission prompt deadlock

Even though the opencode.json config sets all permissions to `allow` or `deny`, opencode's internal permission system can still trigger prompts in certain edge cases (e.g., operations outside the project folder, unexpected tool calls). When no TTY is attached:

1. opencode detects a permission prompt is needed
2. It tries to read from stdin for the user's response
3. stdin is a pipe that either has no data or has been consumed (from the `< /tmp/.prompt.md` redirect)
4. The read blocks forever
5. Zero output is produced because the agent loop hasn't started yet

This was reported in [issue #5888](https://github.com/anomalyco/opencode/issues/5888) and resolved via [issue #10411](https://github.com/anomalyco/opencode/issues/10411) + [PR #11814](https://github.com/anomalyco/opencode/pull/11814) which made `opencode run` non-interactive by default (auto-rejecting permission prompts). The fix was merged **February 14, 2026**.

### Why it works in Docker despite the same risk

Docker's `Tty: true` gives opencode a pseudo-TTY. Even though no human is typing, the TTY is allocated and open. opencode detects `isTTY === true` and may follow a different code path for permission handling. Additionally, the container's `tail -f /dev/null` keeps the session alive, and the TTY provides a valid controlling terminal that prevents the "no stdin" deadlock.

### The stdin redirect interaction

The opencode invocation (opencode/index.ts line 131):
```bash
opencode run "$(cat /tmp/.prompt.md)" < /tmp/.prompt.md
```

The `< /tmp/.prompt.md` redirects a file to opencode's stdin. Once bash reads this file, stdin reaches EOF. In Docker with a TTY, the stdin is the pseudo-TTY (the file redirect is processed by bash, but the TTY remains the controlling terminal). In the local spawn with pipes, once the file is consumed, stdin is truly at EOF -- but opencode may not handle stdin EOF gracefully in all code paths.

---

## Finding 3: Bun-Specific stdin/pipe Issues

**Confidence: MEDIUM** (multiple Bun GitHub issues, but exact version interaction unclear)

Bun has a long history of stdin-related bugs when running without a TTY:

### Known Bun stdin issues

1. **`process.stdin` buffering with pipes** ([issue #18239](https://github.com/oven-sh/bun/issues/18239)): When piping to a Bun process, stdin buffers all input and emits it as a single chunk only after the pipe closes. Real-time processing of piped stdin does not work.

2. **readline prevents exit** ([issue #3604](https://github.com/oven-sh/bun/issues/3604), [PR #15628](https://github.com/oven-sh/bun/pull/15628)): Using `node:readline` with stdin, calling `rl.close()` does not cause the Bun process to exit. The underlying input stream re-opens because `unpause()` is called after close.

3. **Event loop stays alive on subprocess stdout read** ([issue #1498](https://github.com/oven-sh/bun/issues/1498)): Killing a subprocess while reading its buffered stdout causes Bun to remain open forever.

4. **stdin never reads on certain Linux kernels** ([issue #26792](https://github.com/oven-sh/bun/issues/26792)): `process.stdin` never receives data on older kernels. The main process never calls `read(0, ...)` and never adds fd 0 to the event loop.

5. **16 KB stdout pipe hang** (fixed in v1.0.36): When at least 16 KB was piped to `process.stdout`, the process would sometimes hang.

### How this affects the local provider

When opencode (Bun) is spawned via Node.js `spawn` with pipe stdio:
- Bun's event loop may not properly detect that stdin is a pipe vs. a TTY
- The readline/stdin subsystem may keep the event loop alive even after the agent work completes
- On ARM64 Linux specifically, Bun's io_uring fallback path may interact poorly with piped stdin

This explains the observation that opencode sometimes completes its work but the process doesn't exit (requiring the 150s `timeout` kill).

---

## Finding 4: Process Group and Signal Handling

**Confidence: MEDIUM**

### Docker exec creates an isolated process

When Docker exec runs a command with `Tty: true`:
- The process gets its own pseudo-TTY
- It becomes a session leader (via the container's init system)
- Signal delivery is clean: SIGTERM goes directly to the process
- The container's PID namespace isolates signal handling

### Node.js spawn inherits the parent's process group

With default `spawn` options (no `detached: true`):
- The child process is in the **same process group** as the parent
- If the parent receives a signal, the child may also receive it
- The child does NOT have a controlling terminal
- `process.kill(child.pid, 'SIGTERM')` sends to the child only, not its children

The local provider's `timeout` wrapper (line 138-139):
```bash
timeout --signal=TERM --kill-after=10 150 opencode run ...
```

This sends SIGTERM to the opencode process, but `timeout` creates its own process group only when the child is a session leader. Without `--foreground`, timeout may not properly signal all child processes (Ollama subprocesses, etc.).

---

## Finding 5: Potential Fixes

**Confidence: HIGH for diagnosis, MEDIUM for specific fixes**

### Fix 1: Upgrade opencode to a version with non-interactive mode (RECOMMENDED)

[PR #11814](https://github.com/anomalyco/opencode/pull/11814) (merged Feb 14, 2026) makes `opencode run` non-interactive by default. If the installed opencode version includes this fix, the permission-prompt deadlock is eliminated. Check the version:
```bash
opencode --version
```

### Fix 2: Use `stdio: 'inherit'` for stdin (QUICK FIX)

Change the local provider's spawn to inherit the parent's stdin:
```typescript
const child = spawn(bashPath, args, {
    cwd: workspacePath,
    env: childEnv,
    stdio: ['inherit', 'pipe', 'pipe'],  // inherit stdin, pipe stdout/stderr
});
```

**Tradeoff:** This passes the parent's stdin to the child. If the parent is connected to a TTY (interactive), the child gets a TTY too. But in CI (GitHub Actions), the parent likely doesn't have a TTY either, so this may not help.

### Fix 3: Use a pseudo-TTY (pty) for the local spawn

Use a pty library like `node-pty` to allocate a pseudo-TTY for the child:
```typescript
import * as pty from 'node-pty';
const shell = pty.spawn(bashPath, args, {
    cwd: workspacePath,
    env: childEnv,
    cols: 80,
    rows: 24,
});
```

**Tradeoff:** Adds a native dependency. But this replicates exactly what Docker's `Tty: true` does.

### Fix 4: Close stdin immediately after redirect

Instead of `< /tmp/.prompt.md`, explicitly close stdin after the file is consumed:
```bash
opencode run "$(cat /tmp/.prompt.md)" < /tmp/.prompt.md; exec 0<&-
```

Or redirect from `/dev/null` instead:
```bash
opencode run "$(cat /tmp/.prompt.md)" < /dev/null
```

This ensures opencode sees an immediate EOF on stdin rather than a blocked pipe.

### Fix 5: Use `detached: true` with `setsid`

```typescript
const child = spawn(bashPath, args, {
    cwd: workspacePath,
    env: childEnv,
    detached: true,  // creates new session via setsid()
});
```

This gives the child its own session and process group, closer to Docker exec's behavior. Combined with proper signal handling, this ensures cleaner process lifecycle management.

### Fix 6: Redirect stdin from /dev/null at the command level

Modify the opencode invocation in opencode/index.ts:
```typescript
// Instead of:
const opencodeInvocation = `${opencodeBin} run "$(cat /tmp/.prompt.md)" < /tmp/.prompt.md`;
// Use:
const opencodeInvocation = `${opencodeBin} run "$(cat /tmp/.prompt.md)" < /dev/null`;
```

The prompt is already passed as a CLI argument via `$(cat /tmp/.prompt.md)`. The stdin redirect is redundant (or a fallback). Redirecting from `/dev/null` gives opencode an immediate EOF, preventing any stdin-blocking deadlock.

---

## Root Cause Analysis

The hang is caused by a **three-factor interaction**:

1. **No TTY allocated** -- Node.js `spawn` with default pipes gives opencode a non-TTY stdin/stdout
2. **opencode's stdin handling** -- opencode (or Bun's runtime underneath it) blocks on stdin when it encounters a situation requiring input (permission prompt, error handler, or readline initialization)
3. **Bun's event loop** -- Bun has known issues where stdin pipe reads keep the event loop alive even when the main work is complete

In Docker, factor #1 is eliminated by `Tty: true`, which prevents factors #2 and #3 from triggering.

---

## Recommended Fix Priority

1. **Upgrade opencode** to include PR #11814 (non-interactive `run` mode) -- eliminates the permission-prompt deadlock
2. **Redirect stdin from /dev/null** instead of the prompt file -- eliminates the stdin-blocking risk
3. **Consider `node-pty`** for full TTY emulation if other Bun TTY-dependent behaviors surface

---

## Sources

### Node.js / child_process
- [Node.js child_process docs (v25)](https://nodejs.org/api/child_process.html)
- [Node.js TTY docs](https://nodejs.org/api/tty.html)
- [stdout/stderr buffering with TTY -- Node.js #2148](https://github.com/nodejs/node/issues/2148)

### Docker exec / TTY
- [Docker container exec docs](https://docs.docker.com/engine/reference/commandline/exec/)
- [Docker TTY behavior -- Baeldung](https://www.baeldung.com/linux/docker-run-interactive-tty-options)
- [Docker exec carriage return / TTY behavior](https://ddanilov.me/docker-run-exec-and-carriage-return/)

### opencode hanging issues
- [opencode #5888 -- Hangs when used as CLI tool](https://github.com/anomalyco/opencode/issues/5888)
- [opencode #10411 -- Add non-interactive mode to opencode run](https://github.com/anomalyco/opencode/issues/10411)
- [opencode #4506 -- opencode run hangs on errors](https://github.com/anomalyco/opencode/issues/4506)
- [opencode #8203 -- opencode run hangs forever on API errors](https://github.com/anomalyco/opencode/issues/8203)
- [opencode #1717 -- Process hangs after TUI exits](https://github.com/anomalyco/opencode/issues/1717)

### Bun stdin/TTY issues
- [Bun #18239 -- process.stdin buffers all piped input](https://github.com/oven-sh/bun/issues/18239)
- [Bun #3604 -- node:readline prevents exit](https://github.com/oven-sh/bun/issues/3604)
- [Bun #15628 -- Fix readline hang on stdin close](https://github.com/oven-sh/bun/pull/15628)
- [Bun #1498 -- Subprocess stdout read keeps event loop alive](https://github.com/oven-sh/bun/issues/1498)
- [Bun #6461 -- ANSI stdout/stdin query causes hang](https://github.com/oven-sh/bun/issues/6461)
- [Bun #26792 -- process.stdin never reads on Linux kernel 4.18](https://github.com/oven-sh/bun/issues/26792)
- [Bun v1.0.36 release -- stdin non-blocking fix](https://bun.sh/blog/bun-v1.0.36)
- [Bun v1.3.5 release -- Bun.Terminal API](https://bun.com/blog/bun-v1.3.5)

### Process groups / sessions
- [setsid(2) man page](https://man7.org/linux/man-pages/man2/setsid.2.html)
- [Process groups, jobs and sessions](https://biriukov.dev/docs/fd-pipe-session-terminal/3-process-groups-jobs-and-sessions/)
