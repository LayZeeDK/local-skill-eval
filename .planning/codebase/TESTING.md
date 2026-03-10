# Testing Patterns

**Analysis Date:** 2026-03-10

## Test Framework

**Runner:**
- No test framework (Jest, Vitest, Mocha, etc.) is installed
- Tests are plain TypeScript scripts executed directly with `ts-node`
- Config: `tsconfig.json` (shared with `src/`)

**Assertion Library:**
- Hand-rolled `assert(condition, message)` helper defined in each test file
- `assertApproxEqual(actual, expected, tolerance, message)` in `tests/ollama-grader.test.ts`
- No `expect()` or `should` style — all assertions are imperative

**Run Commands:**
```bash
npm run test:bootstrap          # Integration: bootstrap + Docker + secrets
npm run test:analytics          # Unit: analytics engine and NG calculation
npm run test:ollama-grader      # Unit: LLMGrader with mocked fetch
npm run test:docker-cache       # Unit: Docker content-hash naming
npm run test:local-provider     # Integration: LocalProvider PATH augmentation
npm run test:benchmark          # Benchmark: Ollama model performance (not a correctness test)
```

Each command maps to: `ts-node tests/<name>.test.ts`

## Test File Organization

**Location:**
- All tests in top-level `tests/` directory (not co-located with source)

**Naming:**
- `<module>.test.ts` for functional tests (e.g., `analytics.test.ts`, `bootstrap.test.ts`)
- `<concern>.test.ts` for integration/feature-scoped tests (e.g., `docker-cache.test.ts`, `local-provider.test.ts`, `ollama-grader.test.ts`)
- `benchmark-grader.ts` for performance benchmarking (no `.test.` suffix — not a correctness test)

**Structure:**
```
tests/
├── analytics.test.ts          # Unit: calculateNormalizedGain, AnalyticsEngine.aggregate
├── bootstrap.test.ts          # Integration: EvalRunner with Local/Docker provider
├── docker-cache.test.ts       # Unit: computeContextHash determinism
├── local-provider.test.ts     # Integration: LocalProvider.runCommand PATH behavior
├── ollama-grader.test.ts      # Unit: LLMGrader with mock fetch (most comprehensive)
├── benchmark-grader.ts        # Benchmark: raw Ollama model throughput
└── fixtures/
    └── benchmark/
        ├── session-positive.json
        ├── session-empty.json
        └── session-wrong.json
```

## Test Structure

**Two structural patterns exist:**

### Pattern 1: Sequential script with `process.exit(1)` (bootstrap, analytics)
Used in simpler tests or integration tests where test isolation is not needed:
```typescript
async function testAnalytics() {
    // 1. Test NG Calculation
    const testCases = [
        { with: 1.0, without: 0.5, expected: 1.0 },
        // ...
    ];

    for (const tc of testCases) {
        const ng = calculateNormalizedGain(tc.with, tc.without);
        if (Math.abs(ng - tc.expected) < 0.001) {
            console.log(`SUCCESS: NG(${tc.with}, ${tc.without}) = ${ng}`);
        } else {
            console.error(`FAILURE: NG(${tc.with}, ${tc.without}) = ${ng}, expected ${tc.expected}`);
            process.exit(1);
        }
    }
}

testAnalytics();
```

### Pattern 2: Counter-based runner with collected failures (docker-cache, local-provider, ollama-grader)
Used in tests with multiple independent cases where all results should be reported:
```typescript
let passed = 0;
let failed = 0;

async function runTests() {
    // Test 1: <description>
    try {
        const result = await someOperation();
        assert(result.exitCode === 0, `Expected exit code 0, got ${result.exitCode}`);
        console.log('  PASS: <description>');
        passed++;
    } catch (e: any) {
        console.error(`  FAIL: <description> - ${e.message}`);
        failed++;
    }

    console.log(`\nResults: ${passed} passed, ${failed} failed out of ${passed + failed}`);

    if (failed > 0) {
        process.exit(1);
    }
}

runTests().catch((err) => {
    console.error('Test runner error:', err);
    process.exit(1);
});
```

### Pattern 3: Named `test()` helper (ollama-grader — most structured)
```typescript
let passed = 0;
let failed = 0;
const failures: string[] = [];

async function test(name: string, fn: () => Promise<void>) {
    const originalFetch = globalThis.fetch;
    try {
        await fn();
        passed++;
        console.log(`  [PASS] ${name}`);
    } catch (e: any) {
        failed++;
        const msg = e?.message || String(e);
        failures.push(`${name}: ${msg}`);
        console.log(`  [FAIL] ${name}: ${msg}`);
    } finally {
        globalThis.fetch = originalFetch;
    }
}

// Usage:
await test('callOllama returns GraderResult with score and reasoning when Ollama responds with valid JSON', async () => {
    globalThis.fetch = createMockFetch([ollamaHealthOk(), ollamaTagsWithModel(), ollamaGenerateOk(0.85)]);
    const result = await (grader as any).callOllama('test prompt', 'http://localhost:11434', config);
    assert(result !== null, 'result should not be null');
    assertApproxEqual(result.score, 0.85, 0.01, 'score');
});
```

**Test naming style:**
- Full sentence descriptions: `'callOllama returns null when fetch throws connection error (ECONNREFUSED)'`
- Includes both the subject and expected behavior

## Mocking

**Framework:**
- Manual mocking only — no sinon, jest.mock(), or similar library
- `globalThis.fetch` is replaced directly in each test, then restored in `finally`

**Fetch mocking patterns:**

```typescript
// Pattern 1: Route-based mock dispatcher (used in ollama-grader)
interface MockRoute {
    method: string;
    pathPattern: string;
    response: () => Response | Promise<Response>;
}

function createMockFetch(routes: MockRoute[], host: string = 'http://localhost:11434'): typeof globalThis.fetch {
    return (async (input: string | URL | Request, init?: RequestInit) => {
        const url = typeof input === 'string' ? input : input.toString();
        const method = (init?.method || 'GET').toUpperCase();
        for (const route of routes) {
            if (method === route.method.toUpperCase() && url === `${host}${route.pathPattern}`) {
                return route.response();
            }
        }
        throw new Error(`Unexpected fetch: ${method} ${url}`);
    }) as typeof globalThis.fetch;
}

// Pattern 2: Inline custom fetch (used for request body capture)
globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input.toString();
    if (url.endsWith('/api/generate') && init?.method === 'POST') {
        capturedBody = JSON.parse(init.body as string);
        return new Response(JSON.stringify({ response: '...', done: true }), { status: 200 });
    }
    throw new Error(`Unexpected fetch: ${url}`);
}) as typeof globalThis.fetch;
```

**What to Mock:**
- `globalThis.fetch` for all HTTP calls to Ollama, Gemini, and Anthropic APIs
- Method patching via `(instance as any).method = async (...) => { ... }` for spying on private methods

**What NOT to Mock:**
- Filesystem operations (`fs-extra`): real files/directories in `os.tmpdir()` are used
- Child process spawning: real bash execution for `LocalProvider` tests
- Docker daemon: `bootstrap.test.ts` skips Docker tests gracefully when Docker is unavailable (`execSync('docker ps')`)

**Restoring state:**
- `globalThis.fetch` always restored in `finally` block inside the `test()` helper
- `process.env` API keys saved/deleted/restored in `try/finally` blocks:
```typescript
const savedGemini = process.env.GEMINI_API_KEY;
delete process.env.GEMINI_API_KEY;
try {
    // test code
} finally {
    if (savedGemini) { process.env.GEMINI_API_KEY = savedGemini; }
}
```

## Fixtures and Factories

**Test Data:**
```typescript
// Factory functions for grader config (ollama-grader.test.ts)
function makeConfig(overrides: Partial<GraderConfig> = {}): GraderConfig {
    return {
        type: 'llm_rubric',
        rubric: 'prompts/quality.md',
        weight: 1.0,
        ...overrides,
    };
}

// Inline mock session log
const dummySessionLog = [
    { type: 'agent_start' as const, timestamp: new Date().toISOString(), instruction: 'Fix the code' },
    { type: 'command' as const, timestamp: new Date().toISOString(), command: 'superlint check', stdout: 'OK', exitCode: 0 },
    { type: 'agent_result' as const, timestamp: new Date().toISOString(), output: 'Done' },
];

// Inline EvalReport mock (analytics.test.ts)
const mockReports: EvalReport[] = [
    { task: 'task1', pass_rate: 0.5, pass_at_k: 0.5, pass_pow_k: 0.5, trials: [], skills_used: [] },
    { task: 'task1', pass_rate: 1.0, pass_at_k: 1.0, pass_pow_k: 1.0, trials: [], skills_used: ['skill1'] },
];
```

**Reusable route builders (ollama-grader.test.ts):**
```typescript
function ollamaHealthOk(): MockRoute { ... }
function ollamaTagsWithModel(modelName: string = 'qwen2.5:3b'): MockRoute { ... }
function ollamaTagsEmpty(): MockRoute { ... }
function ollamaGenerateOk(score: number = 0.85, reasoning: string = 'Good work'): MockRoute { ... }
function ollamaGenerateMalformed(): MockRoute { ... }
function connectionRefused(): MockRoute { ... }
```

**JSON session fixtures for benchmarking:**
- Located at `tests/fixtures/benchmark/session-positive.json`
- Located at `tests/fixtures/benchmark/session-empty.json`
- Located at `tests/fixtures/benchmark/session-wrong.json`

**Filesystem fixtures:**
- Real task content from `tasks/superlint_demo/` used as fixture input across multiple test files
- Temporary directories created in `os.tmpdir()` with `fs.ensureDir()` and cleaned up with `removeWithRetry()`

## Coverage

**Requirements:** None enforced — no coverage tooling configured

**View Coverage:**
- Not applicable; no `--coverage` flag or coverage reporting available

## Test Types

**Unit Tests:**
- `tests/analytics.test.ts` — pure function testing (`calculateNormalizedGain`, `AnalyticsEngine.aggregate`) against inline mock data
- `tests/docker-cache.test.ts` — `computeContextHash` with real filesystem writes in `os.tmpdir()`
- `tests/ollama-grader.test.ts` — `LLMGrader` with mocked `globalThis.fetch`; 23 named test cases

**Integration Tests:**
- `tests/bootstrap.test.ts` — full `EvalRunner` pipeline using real `LocalProvider` and real task files; optional Docker path
- `tests/local-provider.test.ts` — `LocalProvider.runCommand` with real bash execution and temp workspaces

**Performance / Manual Tests:**
- `tests/benchmark-grader.ts` — CLI script that benchmarks Ollama models; not a correctness test; requires real Ollama instance

## Common Patterns

**Async Testing:**
```typescript
async function runTests() {
    try {
        const result = await provider.runCommand(workspace, 'echo "$PATH"');
        assert(result.stdout.trim().split(':')[0].endsWith('/bin'), 'PATH check');
        console.log('  PASS: workspace bin/ is first on PATH');
        passed++;
    } catch (e: any) {
        console.error(`  FAIL: workspace bin/ is first on PATH - ${e.message}`);
        failed++;
    }
}

runTests().catch((err) => {
    console.error('Test runner error:', err);
    process.exit(1);
});
```

**Error Testing:**
```typescript
await test('callOllama returns null when fetch throws connection error (ECONNREFUSED)', async () => {
    globalThis.fetch = (async () => {
        throw new Error('fetch failed: ECONNREFUSED');
    }) as typeof globalThis.fetch;

    const result = await (grader as any).callOllama('test prompt', 'http://localhost:11434', config);
    assert(result === null, 'result should be null on connection error');
});
```

**Approximate numeric assertions:**
```typescript
function assertApproxEqual(actual: number, expected: number, tolerance: number, message: string) {
    if (Math.abs(actual - expected) > tolerance) {
        throw new Error(`${message}: expected ~${expected}, got ${actual}`);
    }
}

assertApproxEqual(result.score, 0.85, 0.01, 'score');
```

**Testing private methods:**
- Access via `(instance as any).privateMethod()` cast — no reflection utilities
- Example: `await (grader as any).callOllama('test prompt', host, config)`

**Cleanup with retry (Windows file-lock resilience):**
```typescript
async function removeWithRetry(dir: string, retries = 5, delayMs = 200): Promise<void> {
    for (let i = 0; i < retries; i++) {
        try {
            await fs.remove(dir);
            return;
        } catch (err: any) {
            if (i === retries - 1) throw err;
            await new Promise(resolve => setTimeout(resolve, delayMs));
        }
    }
}
```

---

*Testing analysis: 2026-03-10*
