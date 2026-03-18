# Technology Stack

**Analysis Date:** 2026-03-10

## Languages

**Primary:**
- TypeScript 5.9.x - All source code in `src/` and `tests/`

**Secondary:**
- Bash - Task test scripts (`tasks/*/tests/test.sh`), reference solutions (`tasks/*/solution/solve.sh`), and the Ollama benchmark script (`tests/ollama-bench.sh`)
- HTML/JavaScript - Browser-based results viewer (`src/viewer.html`, compiled from `src/viewer.ts`)

## Runtime

**Environment:**
- Node.js >=24.0.0 (currently v24.13.0 on dev machine)

**Package Manager:**
- npm 11.6.2
- Lockfile: `package-lock.json` present

## Frameworks

**Core:**
- None — purpose-built CLI tool with no application framework

**Testing:**
- No test framework — tests use a custom hand-rolled runner in each `tests/*.test.ts` file (sequential async, `process.exit(1)` on failure). No Jest, Vitest, or Mocha.

**Build/Dev:**
- `ts-node` ^10.9.2 — runs TypeScript directly without a prior compile step (all `npm run *` scripts use `ts-node`)
- `typescript` ^5.9.3 — compiles to `dist/` via `tsc` for the `npm run build` command

## Key Dependencies

**Critical:**
- `dockerode` ^4.0.9 — Node.js Docker Engine API client; used in `src/providers/docker.ts` for building images, creating/running/removing containers, and executing commands via `exec`
- `fs-extra` ^11.3.3 — Enhanced `fs` with `pathExists`, `ensureDir`, `copy`, `remove`, `readJSON`, `writeJSON`; used throughout all source files
- `tar-stream` ^3.1.7 — Stream-based TAR packing for injecting skill directories into Docker containers (`src/providers/docker.ts`)
- `toml` ^3.0.0 — Parses `task.toml` task configuration files and `suites/*.toml` suite definitions (`src/evalRunner.ts`, `src/cli.ts`)

**Infrastructure:**
- `@types/dockerode` ^4.0.1 — TypeScript types for dockerode
- `@types/fs-extra` ^11.0.4 — TypeScript types for fs-extra
- `@types/node` ^24.12.0 — Node.js built-in type definitions
- `@types/tar-stream` ^3.1.3 — TypeScript types for tar-stream

## Configuration

**TypeScript:**
- `tsconfig.json` at project root
- `target: ES2024`, `module: CommonJS`, `moduleResolution: node`
- `strict: true`, `esModuleInterop: true`
- Output directory: `./dist`
- Includes: `src/**/*.ts`, `tests/**/*.ts`

**Package type:**
- `"type": "commonjs"` — all modules use CommonJS `require`/`module.exports`

**Environment:**
- No `.env` file at project root (optional; loaded at runtime if present)
- Root `.env` loaded by `src/cli.ts` at startup; task-level `.env` at `tasks/<name>/.env` overrides root
- `GEMINI_API_KEY` and `ANTHROPIC_API_KEY` from process env override `.env` values
- `OLLAMA_HOST` configures LLM grader endpoint (default: `http://localhost:11434`)
- Ollama performance vars: `OLLAMA_FLASH_ATTENTION`, `OLLAMA_KV_CACHE_TYPE`, `OLLAMA_NUM_PARALLEL`, `OLLAMA_NUM_THREAD`

**Build:**
- `npm run build` → `tsc` compiles to `dist/`
- All dev/run scripts bypass compile step with `ts-node` directly

## Platform Requirements

**Development:**
- Node.js 24+
- npm
- Docker (for `--provider=docker`, the default)
- Git Bash (Windows) or bash (Unix) — `LocalProvider` explicitly resolves Git Bash on Windows via `git --exec-path`
- Optional: Ollama running locally for free LLM grading

**Production:**
- Not applicable — this is a local developer tool, not a deployed service

---

*Stack analysis: 2026-03-10*
