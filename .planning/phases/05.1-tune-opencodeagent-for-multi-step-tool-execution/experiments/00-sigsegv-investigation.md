# Investigation: SIGSEGV Rate Increase (~60% to ~94%)

**Date:** 2026-03-12
**Confidence:** HIGH (root cause verified from upstream issues and source analysis)

## Executive Summary

The SIGSEGV crash rate increased from ~60% (Phase 5 Plan 03) to ~94% (Phase 5.1 experiments 01-02) when running the opencode x64 binary on Windows ARM64. The root cause is **Bun runtime x64 emulation instability on Windows ARM64**, not QEMU in the traditional Linux sense. The crash is a known upstream issue (opencode #10302, #4340, Bun #9824). No configuration change we made (num_ctx, model, prompt) caused the increase -- the crash occurs during binary initialization, before Ollama is contacted.

A native Windows ARM64 build was shipped to opencode's dev channel on 2026-03-12 (today). The `opencode-windows-arm64` npm package exists with dev versions and a 0.0.1 placeholder. This is the definitive fix once it reaches a stable release.

## What Changed Between Phase 5 and Phase 5.1

### Version Comparison

| Component | Phase 5 (Mar 11 afternoon) | Phase 5.1 (Mar 11 evening) | Changed? |
|-----------|---------------------------|---------------------------|----------|
| opencode-ai | 1.2.24 | 1.2.24 | No |
| Ollama | 0.17.7 | 0.17.7 | No |
| opencode binary | opencode-windows-x64 (Bun-compiled, 160 MB PE32+ x86-64) | Same | No |
| Windows | 11 Pro 10.0.26220 | Same | No |

### Configuration Comparison

| Setting | Phase 5 (qwen3.5:4b Modelfile) | Phase 5.1 (qwen3:4b Modelfile) | Impact on SIGSEGV? |
|---------|-------------------------------|-------------------------------|-------------------|
| num_ctx | 4096 | 8192 | **No** -- crash occurs before model loads |
| num_predict | 4096 | 4096 | No |
| temperature | 0 | 0 | No |
| num_batch | 1024 | 1024 | No |
| num_thread | 8 | 8 | No |
| Model | qwen3.5:4b | qwen3:4b | No -- crash is pre-model |
| Tool permissions | Full set (10+ tools) | Reduced set (4 tools) | No -- crash is pre-config |
| Prompt prefix | Basic | Research-recommended | No -- crash is pre-prompt |

### Key Finding: Configuration is Irrelevant

The SIGSEGV occurs during opencode binary initialization -- before it contacts Ollama, reads the config file, or loads any model. Evidence:

1. `opencode --version` itself segfaults (verified today, exit code 139)
2. Experiment 01 shows "6/6 opencode invocations crashed before the model could generate any output"
3. Experiment 02 warmup shows "3/3 SIGSEGV, no model output"
4. The binary is a 160 MB Bun-compiled PE32+ x86-64 executable running under Windows ARM64's x64 emulation layer

## Root Cause Analysis

### Primary Cause: Bun Runtime x64 Emulation Instability

opencode is compiled using **Bun's single-file executable compiler** (`bun build --compile`). The resulting binary embeds the Bun runtime, which includes components from:
- Bun's JavaScript engine (JavaScriptCore/WebKit)
- Bun's native I/O subsystem
- Platform-specific code

On Windows ARM64, the x64 binary runs through Microsoft's **Prism** x64 emulation layer (not Linux QEMU). This emulation is generally reliable for simple x64 applications but has known issues with:
- Complex JIT-compiled runtimes (JavaScriptCore uses JIT)
- TUI rendering code (terminal escape sequences + buffer management)
- Multi-threaded code with platform-specific assumptions

### Upstream Issue Chain

1. **opencode #4340**: "[FEATURE] Add Windows arm64 support" (Nov 2025, CLOSED 2026-03-12)
   - Maintainer confirmed: "blocked by upstream Bun issue"
   - Bun did not support Windows ARM64 compilation targets until Bun 1.3.10

2. **opencode #10302**: "Segmentation fault on Windows ARM64" (Jan 2026, OPEN)
   - Reports: "binary launches and loads config, crash occurs after initial setup"
   - Confirmed as Bun runtime x64 emulation issue

3. **Bun #9824**: Windows ARM64 support tracking issue
   - WebKit needed ARM64 Windows support first (oven-sh/WebKit#105)
   - Resolved in Bun 1.3.10 (released 2026-02-28)

4. **Bun #26677**: Pull request adding Windows ARM64 support (merged 2026-02)

### Why the Crash Rate Increased

The increase from ~60% to ~94% is most likely due to **non-deterministic factors in x64 emulation**, not any code or config change:

1. **System memory pressure**: Phase 5 experiments ran earlier in the session with fresher system state. By Phase 5.1 (evening of same day), accumulated process state, Ollama model loads/unloads, and background processes may have increased memory fragmentation.
2. **Prism JIT cache state**: Windows' x64 emulation layer (Prism) caches JIT translations. Cache state varies between runs and can affect crash behavior.
3. **Inherent non-determinism**: The crash rate was always variable. Phase 5 Plan 03 documented "~60%" but this was from a small sample. The true rate may have always been 80-90%, with Phase 5 getting lucky on a few attempts.
4. **Warm Ollama model**: In Phase 5.1, the Ollama model was already loaded from warmup trials, consuming ~3.4 GB RAM. This reduces available memory for Prism's emulation buffers.

### Memory Analysis

| Resource | Usage |
|----------|-------|
| System RAM | 32 GB total, ~9 GB free at check time |
| qwen3:4b model | ~3.4 GB |
| KV cache at num_ctx 8192 | ~0.2-0.4 GB (for 4B model) |
| opencode.exe binary | 160 MB |
| Prism emulation overhead | Unknown, estimated 100-500 MB |

With 9 GB free memory, raw memory exhaustion is unlikely. However, Prism's internal address space management for a 160 MB JIT-compiled binary is the more likely pressure point.

## Mitigation Options (Ranked by Feasibility)

### 1. [BEST] Install Native Windows ARM64 Build (when released)

**Feasibility: HIGH (imminent)**
**Expected impact: Eliminates SIGSEGV entirely**

The `opencode-windows-arm64` npm package was published today (2026-03-12) with dev versions. A maintainer commented: "I just shipped windows arm64 to dev, next release will have this for opencode cli and opencode desktop."

Action:
```bash
# Check for new release periodically
npm view opencode-ai version
# Once a release includes opencode-windows-arm64 in optionalDependencies:
npm install -g opencode-ai@latest
```

Current status: The 0.0.1 version is a placeholder. Dev versions exist (0.0.0-dev-202603120428). The next stable release of opencode-ai should include it in optionalDependencies.

**Risk:** The ARM64 build is brand new and may have its own issues. But it eliminates the emulation layer entirely.

### 2. [GOOD] Run opencode via WSL2 (Linux ARM64 native)

**Feasibility: HIGH**
**Expected impact: Eliminates SIGSEGV (different binary, native execution)**

WSL2 on this machine runs native Linux ARM64. The `opencode-linux-arm64` package (v1.2.24) exists and would run natively without any emulation.

Action:
```bash
# Inside WSL2:
npm install -g opencode-ai
# opencode-linux-arm64 binary will be selected automatically
opencode run "..." < /tmp/prompt.md
```

Concerns:
- Ollama runs on Windows host -- WSL2 can reach it via `localhost` (WSL2 networking) or explicit IP
- opencode issue #13367 (SIGABRT on linux-arm64) was for 64KB page size kernels. WSL2 uses standard 4KB pages, so this should NOT apply
- Requires changes to OpenCodeAgent to detect WSL2 context and route commands appropriately

### 3. [MODERATE] Increase Retry Count from 3 to 5-7

**Feasibility: HIGH (trivial code change)**
**Expected impact: Marginal improvement**

With a ~94% per-attempt crash rate, the probability of all N attempts failing:
- 3 retries: 0.94^3 = 83% all-fail (current)
- 5 retries: 0.94^5 = 73% all-fail
- 7 retries: 0.94^7 = 65% all-fail
- 10 retries: 0.94^10 = 54% all-fail

Even with 10 retries, there is still a >50% chance of total failure. This is not a viable standalone mitigation.

### 4. [MODERATE] Reduce System Memory Pressure Before Each Run

**Feasibility: MEDIUM**
**Expected impact: Unknown, possibly marginal**

Actions:
- Ensure `ollama stop <model>` completes before opencode launch (frees ~3.4 GB)
- Close unnecessary background processes
- Add explicit garbage collection pause between warmup and measured trials

This is speculative -- memory pressure may not be the primary driver.

### 5. [LOW] Lower num_ctx Back to 4096

**Feasibility: HIGH (config change)**
**Expected impact: None on SIGSEGV**

The crash occurs before the model loads, so num_ctx has zero impact on the SIGSEGV rate. The KV cache difference is only ~0.2 GB for a 4B model. However, keeping num_ctx at 8192 is important for opencode's system prompt + tool definitions + conversation history fitting in context.

**Verdict: Do not change.** num_ctx is not causing the SIGSEGV.

### 6. [LOW] Use Docker Provider to Bypass Local SIGSEGV

**Feasibility: MEDIUM (already partially implemented)**
**Expected impact: High for Docker runs, does not fix local**

Docker containers on this machine run native Linux ARM64 via WSL2-backed Docker Desktop. The opencode-linux-arm64 binary would execute natively inside the container with zero emulation.

This is already part of the Phase 5.1 plan (Docker provider must also pass). It is a viable path for CI but does not solve the local provider requirement.

### 7. [FUTURE] Bypass opencode Entirely for Model Testing

**Feasibility: MEDIUM**
**Expected impact: Isolates model capability from platform crashes**

Test tool calling directly via Ollama's /v1 API (curl or Node.js) to confirm model behavior without the opencode binary. This does not replace the OpenCodeAgent requirement but can validate whether the model is capable of multi-step tool calling.

## Recommended Next Steps

### Immediate (before continuing Phase 5.1 experiments)

1. **Check for opencode ARM64 release daily.** The maintainer shipped to dev on 2026-03-12. A stable release could come within days.
   ```bash
   npm view opencode-ai optionalDependencies --json | node -e "const d=require('fs').readFileSync(0,'utf8'); console.log(d.includes('opencode-windows-arm64') ? 'ARM64 AVAILABLE' : 'Not yet')"
   ```

2. **Test the dev version now** (experimental):
   ```bash
   npm install opencode-windows-arm64@dev
   # Then set OPENCODE_BIN_PATH to the ARM64 binary
   ```

3. **Increase retry count to 5** as a stopgap while waiting for ARM64 build. Trivial change in `src/agents/opencode/index.ts` line 118.

### Short-term (if ARM64 release is delayed)

4. **Test WSL2 path**: Install opencode in WSL2, verify Ollama connectivity, run a quick smoke test. This gives a native ARM64 execution path without waiting for the npm release.

### For Phase 5.1 experiments specifically

5. **Do not block experiments on SIGSEGV fix.** The ~6% success rate means some attempts will survive. With patience and retries, model behavior can still be evaluated.
6. **Focus Docker provider testing early** -- it uses native ARM64 and avoids SIGSEGV entirely.

## Conclusion

The SIGSEGV rate increase is a symptom of an inherently unreliable execution path (Bun x64 binary under Windows ARM64 Prism emulation). No configuration change we made caused it. The definitive fix is the native Windows ARM64 build, which is actively being developed and may be available in the next opencode release. In the meantime, increasing retries and testing the WSL2 or Docker paths provide the best alternatives.

## Sources

- [opencode #4340: Add Windows arm64 support](https://github.com/anomalyco/opencode/issues/4340) -- Feature request with full development history, ARM64 shipped to dev 2026-03-12
- [opencode #10302: Segmentation fault on Windows ARM64](https://github.com/anomalyco/opencode/issues/10302) -- Bug report confirming Bun runtime as root cause
- [Bun #9824: Windows ARM64 support tracking](https://github.com/oven-sh/bun/issues/9824) -- Upstream dependency
- [Bun #26677: Windows ARM64 support PR](https://github.com/oven-sh/bun/pull/26677) -- Merged, available in Bun 1.3.10
- [opencode-windows-arm64 on npm](https://www.npmjs.com/package/opencode-windows-arm64) -- Placeholder + dev versions published 2026-03-12
- [Ollama FAQ: Context window memory](https://docs.ollama.com/faq) -- KV cache scales linearly with num_ctx
- Phase 5 Plan 03 SUMMARY (local) -- Historical ~60% SIGSEGV data
- Experiments 01-02 (local) -- Current ~94% SIGSEGV data (15/16 attempts failed)
