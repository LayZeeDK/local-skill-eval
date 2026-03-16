# Research: Bun ARM64 Stdio Pipe Hang -- Zero Output from opencode

**Researched:** 2026-03-16
**Overall confidence:** HIGH
**Mode:** Feasibility

## Executive Summary

The zero-stdout behavior when spawning opencode via `child_process.spawn('bash', ['-c', 'timeout 150 opencode run ...'])` on GitHub Actions ARM64 runners is almost certainly caused by a combination of two factors:

1. **opencode bundles Bun 1.3.5**, which contains a critical stdio pipe bug (fixed in Bun 1.3.10) where `shutdown(SHUT_WR)` on subprocess socketpairs sends a premature FIN, causing pipe readers to interpret it as "connection closed."
2. **opencode's own stdout flushing deficiency** -- documented in opencode issue #2803 -- where `process.exit()` terminates before async pipe writes complete, truncating output at 64 KB buffer boundaries (or producing 0 bytes if exit happens before any buffer flush).

The reason Docker works is that `docker exec` with `Tty: true` allocates a PTY, bypassing the pipe path entirely. With a PTY, Bun uses synchronous line-buffered writes (flushed on every newline) rather than async block-buffered pipe writes.

## Root Cause Analysis

### Primary: Bun 1.3.5 Subprocess Stdio Socketpair Bug

**Confidence: HIGH** (documented in Bun v1.3.10 release notes and PR #27435)

Bun's subprocess stdio implementation used `shutdown(SHUT_WR)` on socketpairs to make them unidirectional. On `SOCK_STREAM` sockets, `shutdown(SHUT_WR)` sends a TCP FIN to the peer. Programs that poll their stdio file descriptors for readability -- including Node.js `child_process` pipe readers -- interpret this FIN as "connection closed" and tear down the transport prematurely.

This was fixed in Bun v1.3.10 (PR #27435) by removing the `shutdown()` calls entirely. However, **opencode's npm binary embeds Bun 1.3.5** (confirmed in opencode issue #11824), and the embedded runtime cannot be updated by installing a newer system Bun.

**Impact:** When Node.js spawns opencode (Bun 1.3.5) with piped stdio, the parent's pipe reader may receive FIN before any data arrives, resulting in 0 bytes read.

### Secondary: Async Stdout Not Flushed Before Exit

**Confidence: HIGH** (documented in opencode issue #2803)

When stdout is a pipe (not a TTY), `console.log()` in Node.js/Bun becomes asynchronous with block buffering (64 KB blocks). If `process.exit()` is called before the write buffer drains, output is truncated or lost entirely. This is a decades-old issue in Node.js (node issue #2972) that Bun inherits.

opencode issue #2803 demonstrates this: piped output truncates at multiples of 65,536 bytes. The proposed fix (flushing streams before exit) has not been fully applied.

### Why Docker Works

**Confidence: HIGH** (mechanical explanation)

The Docker provider uses `docker exec` with `Tty: true`, which allocates a pseudo-terminal (PTY) inside the container. With a PTY:

- `isatty(1)` returns `true`, so Bun/Node.js uses line buffering (flush on every `\n`)
- No socketpair `shutdown()` is involved -- the PTY master/slave pair has different semantics
- Output is synchronous from the application's perspective

The local provider uses `spawn('bash', ['-c', command])` with default stdio (pipes), which triggers both the socketpair bug and the async buffering problem.

## Contributing Factors

### Bun ARM64 Platform Instability

**Confidence: MEDIUM** (multiple issues reported, but not directly proven as a factor here)

Several Bun ARM64-specific bugs have been reported:

- **Issue #26651**: Bun 1.3.7/1.3.8 completely stopped working on aarch64 (Raspberry Pi 3), while 1.3.6 works fine (February 2026)
- **Issue #16057**: Core dump on aarch64 with Bun 1.1.42 (December 2024)
- **Bun v1.0.10 release**: Fixed a Linux ARM64-specific errno handling bug where Bun was reading errno wrong on ARM64 because it assumed libc errno was always in use, but Bun sometimes uses raw syscalls that bypass libc

While the primary cause is likely the socketpair bug, ARM64-specific platform issues may exacerbate the problem or cause additional failure modes.

### opencode's Bun-to-Node.js Migration (In Progress)

**Confidence: HIGH** (documented in changelogs)

The opencode team is actively migrating away from Bun-specific APIs. In v1.2.19-v1.2.20 (March 6, 2026):

- Replaced `Bun.stderr` and `Bun.color` with Node.js equivalents
- Replaced `Bun.connect` with `net.createConnection`
- Replaced `Bun.stdin.text` with Node.js stream reading
- Replaced `Bun.write` with filesystem utilities
- Replaced `Bun.sleep` with Node.js timers
- Replaced `Bun.which` with npm `which`

This migration suggests the opencode team is aware of Bun-specific compatibility issues and is working to reduce Bun coupling. However, the **bundled Bun runtime** (used for `bun build --compile`) remains the execution environment.

## Workarounds

### 1. PTY Allocation via `script` Command (Recommended)

**Confidence: HIGH** -- well-established Linux technique

Use the `script` command to allocate a PTY wrapper around the opencode process:

```bash
script -qec "timeout 150 opencode run 'prompt'" /dev/null
```

This forces `isatty(1)` to return `true` inside the Bun process, switching to line-buffered synchronous writes and avoiding the pipe socketpair path entirely.

**Pros:** No opencode or Bun changes needed. Works immediately.
**Cons:** Output may contain terminal control sequences (carriage returns, ANSI escapes). May need post-processing with `sed` or `col -b` to clean.

### 2. `faketty` Rust Tool

**Confidence: MEDIUM** -- third-party tool, needs installation

The `faketty` tool (github.com/dtolnay/faketty) wraps a command in a PTY specifically for this use case:

```bash
faketty timeout 150 opencode run "prompt"
```

**Pros:** Cleaner than `script`, purpose-built for this.
**Cons:** Requires installing a Rust binary on the CI runner. May not have ARM64 prebuilds.

### 3. `unbuffer` from `expect` Package

**Confidence: HIGH** -- standard package

```bash
unbuffer timeout 150 opencode run "prompt"
```

**Pros:** Available via `apt install expect`. Well-tested. Allocates a PTY.
**Cons:** Pulls in the `expect` package as a dependency.

### 4. Upgrade opencode Binary Bun Version

**Confidence: LOW** -- depends on upstream

If the opencode team rebuilds their npm binary with Bun >= 1.3.10, the socketpair bug is fixed. However:

- opencode-ai@latest (1.2.26) still bundles Bun 1.3.5
- The user cannot control when the team upgrades
- Even with the socketpair fix, the stdout flush-before-exit issue may still cause partial output loss

### 5. BUN_CONFIG_VERBOSE_FETCH and Other Env Vars

**Confidence: LOW** -- unlikely to help

Bun does not expose a `BUN_FORCE_FLUSH_STDOUT` or similar environment variable. The documented env vars (`BUN_CONFIG_VERBOSE_FETCH`, `BUN_GARBAGE_COLLECTOR_LEVEL`) are unrelated to stdio flushing.

### 6. Explicit Flush in Bun (`Bun.stdout.writer().flush()`)

**Confidence: N/A** -- requires code changes in opencode

Bun provides `Bun.stdout.writer()` with an explicit `.flush()` method. This would need to be called before every `process.exit()` in opencode's source. Not actionable without forking opencode.

## Diagnosis Checklist

To confirm the root cause in CI, add these diagnostic steps before the opencode spawn:

```bash
# Check which Bun version opencode is using
opencode --version 2>&1 || true
# or:
npx opencode-ai --version 2>&1 || true

# Check if Bun binary responds at all
file $(which opencode)  # Should show ELF aarch64
ldd $(which opencode) 2>&1 || true  # Check dynamic linking

# Test basic Bun stdio on the runner
echo 'console.log("hello from bun")' | bun run - 2>&1

# Test with PTY allocation
script -qec 'echo "hello from script PTY"' /dev/null
```

## Key Evidence Summary

| Evidence | Source | Confidence |
|----------|--------|------------|
| Bun 1.3.5 socketpair `shutdown()` sends premature FIN on pipes | [Bun v1.3.10 blog](https://bun.com/blog/bun-v1.3.10), PR #27435 | HIGH |
| opencode npm binary embeds Bun 1.3.5 | [opencode issue #11824](https://github.com/anomalyco/opencode/issues/11824) | HIGH |
| opencode truncates piped stdout at 64KB boundaries | [opencode issue #2803](https://github.com/sst/opencode/issues/2803) | HIGH |
| Docker `Tty: true` allocates PTY, bypassing pipe path | Docker API documentation | HIGH |
| Bun ARM64 errno misread (fixed v1.0.10) | [Bun v1.0.10 blog](https://bun.com/blog/bun-v1.0.10) | MEDIUM |
| Bun ARM64 regressions in 1.3.7+ | [Bun issue #26651](https://github.com/oven-sh/bun/issues/26651) | MEDIUM |
| `script -qec` allocates PTY for non-interactive processes | [script(1) man page](https://man7.org/linux/man-pages/man1/script.1.html) | HIGH |
| opencode migrating away from Bun APIs (v1.2.19-1.2.20) | [opencode v1.2.19 release](https://github.com/anomalyco/opencode/releases/tag/v1.2.19) | HIGH |

## Recommendation

**Use `script -qec` as the immediate workaround.** This is the lowest-risk, zero-dependency fix that addresses both the socketpair bug and the buffering issue by giving Bun a PTY instead of a pipe.

In the local provider's spawn logic, change:

```bash
# Before (pipe -- triggers Bun 1.3.5 socketpair bug)
timeout 150 opencode run "prompt"

# After (PTY allocation -- bypasses pipe path entirely)
script -qec 'timeout 150 opencode run "prompt"' /dev/null
```

If `script` output contains unwanted control sequences, pipe through `col -b` or `sed 's/\r//g'` to strip them.

**Long-term:** Monitor opencode releases for a Bun >= 1.3.10 rebuild. Once the embedded Bun is updated, the `script` wrapper may no longer be needed (though it remains a good defensive practice).

## Sources

- [Bun v1.3.10 Release Blog -- socketpair shutdown fix](https://bun.com/blog/bun-v1.3.10)
- [Bun PR #27435 -- remove shutdown() on subprocess stdio socketpairs](https://github.com/oven-sh/bun/pull/27435)
- [Bun Issue #24690 -- Bun.spawn stdout:pipe returns empty output](https://github.com/oven-sh/bun/issues/24690)
- [Bun Issue #26651 -- Bun 1.3.7/1.3.8 broke aarch64](https://github.com/oven-sh/bun/issues/26651)
- [Bun Issue #16057 -- Core dump on aarch64](https://github.com/oven-sh/bun/issues/16057)
- [Bun v1.0.10 Blog -- ARM64 errno fix](https://bun.com/blog/bun-v1.0.10)
- [Bun Issue #11297 -- pipe file stream to process hangs](https://github.com/oven-sh/bun/issues/11297)
- [opencode Issue #11824 -- Binary locked to Bun 1.3.5](https://github.com/anomalyco/opencode/issues/11824)
- [opencode Issue #2803 -- Truncated stdout when piping](https://github.com/sst/opencode/issues/2803)
- [opencode v1.2.19 Release -- Bun API replacements](https://github.com/anomalyco/opencode/releases/tag/v1.2.19)
- [opencode v1.2.20 Release -- More Bun API replacements](https://github.com/anomalyco/opencode/releases/tag/v1.2.20)
- [opencode Issue #10411 -- Feature request for non-interactive mode](https://github.com/anomalyco/opencode/issues/10411)
- [faketty -- PTY wrapper tool](https://github.com/dtolnay/faketty)
- [script(1) man page](https://man7.org/linux/man-pages/man1/script.1.html)
