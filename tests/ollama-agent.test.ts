/**
 * Unit tests for OllamaToolAgent -- no running Ollama server required.
 */
import { OllamaToolAgent } from '../src/agents/ollama';
import { smokeTestToolCalling } from '../src/agents/ollama/smoke-test';
import { BaseAgent } from '../src/types';

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

console.log('OllamaToolAgent unit tests\n');

// Test 1: Constructable with default config
const defaultAgent = new OllamaToolAgent();
assert(defaultAgent !== null && defaultAgent !== undefined, 'OllamaToolAgent is constructable with default config');

// Test 2: Constructable with custom config
const customAgent = new OllamaToolAgent({
    model: 'custom-model',
    host: 'http://localhost:9999',
    maxIterations: 10,
});
assert(customAgent !== null && customAgent !== undefined, 'OllamaToolAgent is constructable with custom config');

// Test 3: Extends BaseAgent
assert(defaultAgent instanceof BaseAgent, 'OllamaToolAgent extends BaseAgent (instanceof check)');

// Test 4: Has run method
assert(typeof defaultAgent.run === 'function', 'OllamaToolAgent has run method');

// Test 5: smokeTestToolCalling is a function
assert(typeof smokeTestToolCalling === 'function', 'smokeTestToolCalling is a function');

// Summary
console.log(`\nResults: ${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
