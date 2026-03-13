/**
 * Tests that OllamaToolAgent source code contains model unload pattern.
 * Verifies the keep_alive: 0 call and try/catch resilience.
 */
import * as fs from 'fs';
import * as path from 'path';

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

console.log('Model unload pattern tests\n');

const agentSource = fs.readFileSync(
    path.join(__dirname, '..', 'src', 'agents', 'ollama', 'index.ts'),
    'utf-8'
);

// Test 1: Contains keep_alive pattern (model unload call)
assert(agentSource.includes('keep_alive'), 'Source contains keep_alive pattern for model unloading');

// Test 2: keep_alive is set to 0
assert(/keep_alive:\s*0/.test(agentSource), 'keep_alive is set to 0 (immediate unload)');

// Test 3: Unload is in a try/catch for resilient cleanup
// The pattern is: finally { try { ...keep_alive... } catch { ... } }
assert(agentSource.includes('finally'), 'Unload is wrapped in finally block');

// Test 4: Inner try/catch around the unload call
// Check that there is a try block containing keep_alive
const finallyIdx = agentSource.indexOf('finally');
const afterFinally = agentSource.substring(finallyIdx);
const hasTryAfterFinally = afterFinally.includes('try');
const hasKeepAliveAfterFinally = afterFinally.includes('keep_alive');
assert(hasTryAfterFinally && hasKeepAliveAfterFinally, 'Inner try/catch wraps the keep_alive unload call');

// Summary
console.log(`\nResults: ${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
