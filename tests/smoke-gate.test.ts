/**
 * Unit tests for the smoke test gate module.
 * Tests module structure and connection error handling (no live Ollama needed).
 */
import { smokeTestToolCalling } from '../src/agents/ollama/smoke-test';

let passed = 0;
let failed = 0;

function assert(condition: boolean, message: string): void {
    if (condition) {
        console.log(`  [PASS] ${message}`);
        passed++;
    } else {
        console.error(`  [FAIL] ${message}`);
        failed++;
    }
}

async function runTests(): Promise<void> {
    console.log('Smoke gate unit tests\n');

    // Test 1: smokeTestToolCalling is exported and is a function
    assert(typeof smokeTestToolCalling === 'function', 'smokeTestToolCalling is exported and is a function');

    // Test 2: Returns a promise (async function)
    const result = smokeTestToolCalling('http://localhost:1', 'nonexistent-model');
    assert(result instanceof Promise, 'smokeTestToolCalling returns a Promise (is async)');

    // Test 3: Connection refused returns { passed: false, error: '...' }
    const connResult = await result;
    assert(connResult.passed === false, 'Unreachable host returns passed: false');
    assert(typeof connResult.error === 'string' && connResult.error.length > 0, 'Unreachable host returns an error message');

    // Summary
    console.log(`\nResults: ${passed} passed, ${failed} failed`);
    process.exit(failed > 0 ? 1 : 0);
}

runTests();
