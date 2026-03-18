# Coding Conventions

**Analysis Date:** 2026-03-10

## Naming Patterns

**Files:**
- `camelCase.ts` for modules with a single primary export (e.g., `evalRunner.ts`, `cli.ts`)
- `kebab-case` not used; multi-word files are camelCase
- Test files: `<module>.test.ts` or `<module>-<concern>.test.ts` (e.g., `analytics.test.ts`, `docker-cache.test.ts`)
- Benchmark/utility scripts: `<purpose>-<noun>.ts` (e.g., `benchmark-grader.ts`)

**Classes:**
- PascalCase (e.g., `EvalRunner`, `LocalProvider`, `DockerProvider`, `LLMGrader`, `DeterministicGrader`, `ClaudeAgent`, `GeminiAgent`, `AnalyticsEngine`)

**Functions:**
- camelCase (e.g., `loadTaskConfig`, `computeContextHash`, `calculateNormalizedGain`, `calculatePassAtK`, `runCliPreview`, `resolveGitBash`)

**Variables and Parameters:**
- camelCase (e.g., `taskPath`, `skillsPaths`, `numTrials`, `logDir`, `ollamaHost`)
- Unused parameters prefixed with `_` (e.g., `_workspacePath`, `_taskPath`, `_sessionLog`)

**Interfaces:**
- PascalCase (e.g., `CommandResult`, `TaskConfig`, `GraderResult`, `EvalReport`, `EnvironmentProvider`, `AggregateStats`)
- Exported from `src/types.ts` for shared domain types; module-local interfaces defined inline

**Constants:**
- `SCREAMING_SNAKE_CASE` for module-level constants (e.g., `PORT`, `DEFAULT_MODELS`, `GRADING_JSON_SCHEMA`, `GENERATE_TIMEOUT_MS`, `OLLAMA_NUM_CTX`)

**Type Aliases / Union Types:**
- Defined inline in interfaces where possible (e.g., `type: 'agent_start' | 'command' | 'agent_result'`)

## Code Style

**Formatting:**
- No Prettier or ESLint config present at project root
- Indentation: 4 spaces (consistent across all source files)
- Single quotes for string literals in TypeScript source
- Trailing commas in multiline object/array literals (common but not universal)
- Semicolons: present consistently

**TypeScript strictness:**
- `"strict": true` in `tsconfig.json` — all strict checks enabled
- `target: "ES2024"`, `module: "CommonJS"`, `moduleResolution: "node"`
- `skipLibCheck: true`

**Line length:**
- No enforced max, but long lines avoided; chained methods typically broken across lines

**Brace style:**
- K&R style: opening brace on same line as statement
- Braces present on all control flow bodies (no braceless one-liners)

## Import Organization

**Order (observed pattern):**
1. Node.js built-ins (`import * as fs`, `import * as path`, `import * as http`, `import * as os`, `import { createHash }`)
2. Third-party packages (`import Docker from 'dockerode'`, `import * as toml from 'toml'`, `import * as tar from 'tar-stream'`)
3. Local project imports (`import { BaseAgent, CommandResult } from '../types'`, `import { EvalRunner } from './evalRunner'`)

**Import Style:**
- Namespace imports (`import * as fs from 'fs-extra'`) for large modules
- Named imports for specific symbols (`import { createHash } from 'node:crypto'`)
- Default imports for packages that export a default (`import Docker from 'dockerode'`)
- No barrel/index files; direct file imports only

**Path Aliases:**
- None configured — all imports use relative paths (`../types`, `./providers/docker`)

## Error Handling

**Patterns:**
- `try/catch` blocks for async operations; errors logged with `console.error` or `console.warn` before returning null or a fallback value
- Functions that can fail gracefully return `null` or a structured error object rather than throwing (e.g., `callOllama` returns `null` on connection error)
- Timeout wrapping via `withTimeout()` helper in `src/evalRunner.ts` for agent execution
- `process.exit(1)` on unrecoverable errors in CLI and test scripts
- Empty catch blocks only in cleanup paths where errors are expected and safe to ignore: `catch { }` or `catch (e) { // Already removed }`
- `catch` with typed error variable: `catch (err: any)` — accessing `err?.message` safely

**Error messages:**
- Include context: `\`${label} timed out after ${timeoutMs / 1000}s\``
- Actionable messages for user-facing errors: `"Ollama is not running at ${ollamaHost}. Start it with: ollama serve"`

## Logging

**Framework:** `console` (no logging library)

**Patterns:**
- `console.log` for informational progress output
- `console.warn` for non-fatal issues (e.g., Ollama unavailable, warmup failed, suboptimal config)
- `console.error` for failures
- Structured prefixes in grader/LLM code: `[LLMGrader]`, `[INFO]`, `[OK]`, `[ERROR]`, `[WARN]`, `[SKIP]`
- `process.stdout.write` for inline status (without newline): `process.stdout.write('  Trial 1/3 ')`

## Comments

**When to Comment:**
- JSDoc `/** ... */` blocks on exported functions and classes that explain non-obvious behavior (e.g., `calculatePassAtK`, `computeContextHash`, `resolveGitBash`)
- Inline `//` comments for algorithm steps, magic numbers, and non-obvious logic
- File-level JSDoc blocks at top of test files to describe scope and link to related patterns

**JSDoc/TSDoc style:**
- Not consistently using `@param`/`@returns` tags; prefers prose description over tagged annotations
- Example from `src/evalRunner.ts`:
```typescript
/**
 * Calculate pass@k: probability of at least 1 success in k trials
 * Using unbiased estimator: 1 - C(n-c, k) / C(n, k)
 * where n = total trials, c = successes, k = attempts
 */
function calculatePassAtK(n: number, c: number, k: number): number {
```

**Section dividers in long files:**
- Used in `tests/benchmark-grader.ts` to organize sections:
```typescript
// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------
```
- Used in `src/reporters/cli.ts`:
```typescript
// ─── ANSI helpers ──────────────────────────────────────────
```

## Function Design

**Size:**
- Most functions are 10–40 lines; longer functions (e.g., `runSingleTrial`, `benchmarkSingleRun`) kept cohesive with inline comments as section markers

**Parameters:**
- Positional parameters, typically 2–5 in number
- Optional parameters use `?` suffix or default values (e.g., `numTrials: number = 1`, `env?: Record<string, string>`)
- Record types used for flexible key-value maps: `Record<string, string>` for env vars

**Return Values:**
- Async functions return `Promise<T>` with concrete types
- Nullable returns typed as `T | null` (e.g., `Promise<GraderResult | null>`)
- Void cleanup methods declared as `Promise<void>`

## Module Design

**Exports:**
- Named exports for all public types, classes, and functions
- No default exports in source modules (only `import Docker from 'dockerode'` as third-party default)
- Abstract base class `BaseAgent` in `src/types.ts` used as interface contract

**Class Patterns:**
- Private fields with `private` keyword and camelCase (e.g., `private provider`, `private logDir`, `private warmedUp`)
- Private methods with `private` keyword for implementation details; public methods for the interface
- Module-level cached singletons using `let _cachedBashPath: string | null = null` pattern

**Type Assertions:**
- `as any` used for untyped external API responses (Ollama, Gemini, Anthropic JSON)
- Explicit type parameters on `createHash`, `new Promise<T>`, etc.

---

*Convention analysis: 2026-03-10*
